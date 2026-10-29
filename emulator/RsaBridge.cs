// Compiled into the pinned Ryubing build by build.sh. No game memory access.
using Ryujinx.Graphics.GAL;
using Ryujinx.Common.Logging;
using Ryujinx.Ava.UI.Controls;
using Avalonia.Threading;
using Ryujinx.HLE.HOS.Services.Hid;
using SkiaSharp;
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Ryujinx.Ava.Systems;

internal sealed class RsaBridge : IDisposable
{
    public static RsaBridge Current { get; private set; }
    public bool Owned { get { lock (_gate) return _epoch != null; } }
    private readonly object _gate = new();
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _lifetime = new();
    private TcpClient _client;
    private string _epoch;
    private ActionRun _action;
    private Capture _capture;
    private GamepadInput _state;
    private bool _touchDown;
    private uint _touchX;
    private uint _touchY;
    private bool _touchReleasePending;
    private TaskCompletionSource<string[]> _touchRequest;
    private string _touchCommandId;
    private long _frame;

    private sealed record Span(GamepadInput State, long EndMs);
    private sealed class ActionRun(string id, Span[] spans)
    {
        public readonly string Id = id;
        public readonly Span[] Spans = spans;
        public readonly TaskCompletionSource<string[]> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long Started;
        public int Polls;
    }
    private sealed class Capture(string path)
    {
        public readonly string Path = path;
        public readonly TaskCompletionSource<string[]> Done = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly long ReceivedAt = Stopwatch.GetTimestamp();
        public bool Requested;
        public long Frame;
        public long QueuedAt;
    }

    public RsaBridge(int port)
    {
        _listener = new TcpListener(IPAddress.Loopback, port);
        _listener.Start();
        Current = this;
        _ = Serve();
    }

    // Called at the actual Npad input boundary, including when the window is unfocused.
    // null means native human input; an empty struct means AI owns a neutral pad.
    public GamepadInput? Poll()
    {
        lock (_gate)
        {
            if (_epoch == null) return null;
            if (_action != null)
            {
                if (_action.Started == 0) _action.Started = Stopwatch.GetTimestamp();
                double elapsed = Stopwatch.GetElapsedTime(_action.Started).TotalMilliseconds;
                Span span = _action.Spans.FirstOrDefault(item => elapsed < item.EndMs);
                if (span == null) FinishAction("completed");
                else
                {
                    _state = span.State;
                    _action.Polls++;
                }
            }
            return _state;
        }
    }

    // A held contact survives between calls. null restores native mouse-to-touch input.
    // A final neutral sample releases the contact before returning control to the user.
    public (bool Down, uint X, uint Y)? PollTouch()
    {
        lock (_gate)
        {
            if (_touchReleasePending)
            {
                _touchReleasePending = false;
                return (false, _touchX, _touchY);
            }
            if (_epoch == null) return null;
            _touchRequest?.TrySetResult(["completed"]);
            _touchRequest = null;
            return (_touchDown, _touchX, _touchY);
        }
    }

    private Task<string[]> Touch(string operation, string[] fields)
    {
        if (_touchRequest != null) throw new InvalidOperationException("TOUCH_BUSY");
        if (operation == "TOUCH_UP")
        {
            if (fields.Length != 3) throw new ArgumentException("Invalid touch command");
            if (!_touchDown) return Task.FromResult(new[] { "completed" });
            _touchDown = false;
        }
        else
        {
            if ((operation == "TOUCH_DOWN") == _touchDown)
                throw new InvalidOperationException(_touchDown ? "TOUCH_ALREADY_DOWN" : "TOUCH_NOT_DOWN");
            if (fields.Length != 5 || !uint.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out uint x)
                || !uint.TryParse(fields[4], NumberStyles.None, CultureInfo.InvariantCulture, out uint y)
                || x > 1279 || y > 719) throw new ArgumentException("TOUCH_OUT_OF_RANGE");
            _touchX = x;
            _touchY = y;
            _touchDown = true;
        }
        _touchCommandId = fields[0];
        _touchRequest = new(TaskCreationOptions.RunContinuationsAsynchronously);
        return _touchRequest.Task;
    }

    private void ReleaseTouch()
    {
        _touchDown = false;
        _touchCommandId = null;
        _touchReleasePending = true;
        _touchRequest?.TrySetResult(["interrupted"]);
        _touchRequest = null;
    }

    // Invoked on the GPU thread immediately before presentation.
    public void BeforePresent(IRenderer renderer)
    {
        Capture capture;
        long frame;
        lock (_gate)
        {
            frame = ++_frame;
            capture = _capture is { Requested: false } ? _capture : null;
        }
        if (capture == null) return;

        // The full renderer queues this action behind older presentations and
        // waits for it before the GPU thread submits the next Present. Never
        // hold _gate across that wait: capture callbacks also acquire it.
        renderer.BackgroundContextAction(() =>
        {
            lock (_gate)
            {
                if (_capture != capture) return;
                capture.Requested = true;
                capture.Frame = frame;
                capture.QueuedAt = Stopwatch.GetTimestamp();
                renderer.Screenshot();
            }
        });
    }

    public bool ScreenCaptured(ScreenCaptureImageInfo image)
    {
        long callbackAt = Stopwatch.GetTimestamp();
        Capture capture;
        lock (_gate)
        {
            capture = _capture;
            if (capture == null || !capture.Requested) return false;
            _capture = null;
        }
        // Encoding off the renderer thread keeps capture from stalling the game.
        _ = Task.Run(() =>
        {
            long workerAt = Stopwatch.GetTimestamp();
            try
            {
                SKColorType format = image.IsBgra ? SKColorType.Bgra8888 : SKColorType.Rgba8888;
                using SKBitmap source = new(new SKImageInfo(image.Width, image.Height, format, SKAlphaType.Premul));
                Marshal.Copy(image.Data, 0, source.GetPixels(), image.Data.Length);
                using SKBitmap target = new(image.Width, image.Height);
                using SKCanvas canvas = new(target);
                canvas.Clear(SKColors.Black);
                canvas.SetMatrix(SKMatrix.CreateScale(image.FlipX ? -1 : 1, image.FlipY ? -1 : 1, image.Width / 2f, image.Height / 2f));
                canvas.DrawBitmap(source, SKPoint.Empty);
                // Capture favors latency: lossless level 1 avoids ~0.5s of PNG compression per 1080p frame.
                using SKPixmap pixels = target.PeekPixels();
                using SKData png = pixels.Encode(new SKPngEncoderOptions(SKPngEncoderFilterFlags.AllFilters, 1));
                using FileStream file = File.Create(capture.Path);
                png.SaveTo(file);
                file.Flush();
                long completedAt = Stopwatch.GetTimestamp();
                capture.Done.TrySetResult([capture.Frame.ToString(CultureInfo.InvariantCulture)]);
                LogCapture(capture, "game", capture.Frame, completedAt, writer =>
                {
                    writer.WriteNumber("receivedToQueuedMs", Stopwatch.GetElapsedTime(capture.ReceivedAt, capture.QueuedAt).TotalMilliseconds);
                    writer.WriteNumber("queuedToCallbackMs", Stopwatch.GetElapsedTime(capture.QueuedAt, callbackAt).TotalMilliseconds);
                    writer.WriteNumber("callbackToWorkerMs", Stopwatch.GetElapsedTime(callbackAt, workerAt).TotalMilliseconds);
                    writer.WriteNumber("encodeSaveMs", Stopwatch.GetElapsedTime(workerAt, completedAt).TotalMilliseconds);
                });
            }
            catch (Exception error) { capture.Done.TrySetException(error); }
        });
        return true;
    }

    // Foreground Switch software keyboards pause game presentation. Capture the
    // actual Avalonia dialog instead, never a desktop-wide screenshot or game RAM.
    public void CaptureDialog()
    {
        Dispatcher.UIThread.Post(() =>
        {
            lock (_gate)
            {
                if (_capture == null || SwkbdAppletDialog.RsaActive == null) return;
                Capture capture = _capture;
                _capture = null;
                long startedAt = Stopwatch.GetTimestamp();
                try
                {
                    SwkbdAppletDialog.RsaActive.RsaCapture(capture.Path);
                    long completedAt = Stopwatch.GetTimestamp();
                    // The game-frame counter has not advanced; don't invent a frame.
                    capture.Done.TrySetResult([_frame.ToString(CultureInfo.InvariantCulture), "keyboard"]);
                    LogCapture(capture, "keyboard", null, completedAt, writer =>
                    {
                        writer.WriteNumber("receivedToUiMs", Stopwatch.GetElapsedTime(capture.ReceivedAt, startedAt).TotalMilliseconds);
                        writer.WriteNumber("captureSaveMs", Stopwatch.GetElapsedTime(startedAt, completedAt).TotalMilliseconds);
                    });
                }
                catch (Exception error) { capture.Done.TrySetException(error); }
            }
        }, DispatcherPriority.Background);
    }

    private static void LogCapture(Capture capture, string surface, long? frame, long completedAt, Action<Utf8JsonWriter> writeStages)
    {
        if (Logger.Info is not { } logger) return;
        using MemoryStream output = new();
        using (Utf8JsonWriter writer = new(output))
        {
            writer.WriteStartObject();
            writer.WriteString("surface", surface);
            writer.WriteString("path", capture.Path);
            if (frame.HasValue) writer.WriteNumber("frame", frame.Value);
            else writer.WriteNull("frame");
            writeStages(writer);
            writer.WriteNumber("totalMs", Stopwatch.GetElapsedTime(capture.ReceivedAt, completedAt).TotalMilliseconds);
            writer.WriteEndObject();
        }
        logger.Print(LogClass.Application, "RSA_CAPTURE " + Encoding.UTF8.GetString(output.GetBuffer(), 0, (int)output.Length));
    }

    private async Task<string[]> Keyboard(string epoch, string operation, string value)
    {
        return await Dispatcher.UIThread.InvokeAsync(() =>
        {
            lock (_gate)
            {
                // Recheck after dispatch: a queued UI command cannot outlive auto off.
                if (_epoch != epoch) throw new InvalidOperationException("STALE_EPOCH");
                SwkbdAppletDialog dialog = SwkbdAppletDialog.RsaActive ?? throw new InvalidOperationException("NO_TEXT_INPUT");
                dialog.RsaInput(operation, value);
                return Array.Empty<string>();
            }
        });
    }

    private void FinishAction(string outcome)
    {
        _state = default;
        if (_action == null) return;
        double elapsed = _action.Started == 0 ? 0 : Stopwatch.GetElapsedTime(_action.Started).TotalMilliseconds;
        _action.Done.TrySetResult([outcome, elapsed.ToString("F2", CultureInfo.InvariantCulture), _action.Polls.ToString(CultureInfo.InvariantCulture)]);
        _action = null;
    }

    private void Reset()
    {
        lock (_gate)
        {
            FinishAction("interrupted");
            if (_epoch != null) ReleaseTouch();
            _epoch = null;
            _capture?.Done.TrySetException(new IOException("Device bridge disconnected"));
            _capture = null;
        }
    }

    private async Task Serve()
    {
        try
        {
            while (!_lifetime.IsCancellationRequested)
            {
                using TcpClient client = await _listener.AcceptTcpClientAsync(_lifetime.Token);
                _client = client;
                client.NoDelay = true;
                using NetworkStream stream = client.GetStream();
                using StreamReader reader = new(stream, Encoding.UTF8);
                using StreamWriter writer = new(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
                object writerGate = new();
                try
                {
                    string line;
                    while ((line = await reader.ReadLineAsync(_lifetime.Token)) != null)
                    {
                        // Start in wire order, but don't block STOP behind an active APPLY/CAPTURE.
                        _ = Reply(line.Split('\t'), writer, writerGate);
                    }
                }
                catch (IOException) { }
                finally { Reset(); _client = null; }
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (SocketException) when (_lifetime.IsCancellationRequested) { }
    }

    private async Task Reply(string[] fields, StreamWriter writer, object writerGate)
    {
        string response;
        try { response = fields[0] + "\tOK\t" + string.Join('\t', await Execute(fields)); }
        catch (Exception error) { response = fields[0] + "\tERROR\t" + error.Message.Replace('\n', ' ').Replace('\r', ' ').Replace('\t', ' '); }
        try { lock (writerGate) writer.WriteLine(response); }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    private Task<string[]> Execute(string[] fields)
    {
        lock (_gate)
        {
            string op = fields[1];
            if (op == "HELLO") return Task.FromResult(new[] { "ryubing-rsa-3" });
            if (op == "TOUCH_INFO") return Task.FromResult(new[] { "0", "0", "1279", "719" });
            if (op == "CAPTURE")
            {
                if (_capture != null) throw new InvalidOperationException("CAPTURE_BUSY");
                if (!Path.IsPathFullyQualified(fields[2])) throw new ArgumentException("Absolute capture path required");
                Capture capture = new(fields[2]);
                _capture = capture;
                CaptureDialog();
                return AwaitCapture(capture);
            }
            string epoch = fields[2];
            if (op == "OWN")
            {
                if (_epoch != null) throw new InvalidOperationException("OWNED");
                _epoch = epoch;
                _state = default;
                _touchDown = false;
                return Task.FromResult(Array.Empty<string>());
            }
            if (_epoch == null || _epoch != epoch) throw new InvalidOperationException("STALE_EPOCH");
            switch (op)
            {
                case "KEYBOARD": return Keyboard(epoch, fields[3], Encoding.UTF8.GetString(Convert.FromBase64String(fields[4])));
                case "TOUCH_DOWN": case "TOUCH_MOVE": case "TOUCH_UP": return Touch(op, fields);
                case "DISOWN": FinishAction("interrupted"); ReleaseTouch(); _epoch = null; break;
                case "STOP":
                    if (fields.Length < 4 || fields[3] == _action?.Id) FinishAction("interrupted");
                    if (fields.Length < 4 || fields[3] == _touchCommandId) ReleaseTouch();
                    break;
                case "STATE": return Task.FromResult(new[] {
                    ((long)_state.Buttons).ToString(CultureInfo.InvariantCulture),
                    _state.LStick.Dx.ToString(CultureInfo.InvariantCulture), _state.LStick.Dy.ToString(CultureInfo.InvariantCulture),
                    _state.RStick.Dx.ToString(CultureInfo.InvariantCulture), _state.RStick.Dy.ToString(CultureInfo.InvariantCulture), _action?.Id ?? "-" });
                case "APPLY":
                    if (_action != null) throw new InvalidOperationException("BUSY");
                    _action = new ActionRun(fields[0], ParseSpans(fields[3]));
                    return _action.Done.Task;
                default: throw new ArgumentException("Unknown bridge operation");
            }
            return Task.FromResult(Array.Empty<string>());
        }
    }

    private async Task<string[]> AwaitCapture(Capture capture)
    {
        try { return await capture.Done.Task.WaitAsync(TimeSpan.FromSeconds(15), _lifetime.Token); }
        finally { lock (_gate) { if (_capture == capture) _capture = null; } }
    }

    private static Span[] ParseSpans(string sequence)
    {
        long end = 0;
        return sequence.Split(',').Select(raw =>
        {
            string[] fields = raw.Split(':');
            if (fields.Length != 6) throw new ArgumentException("Invalid state sequence");
            int[] parts = fields.Take(5).Select(value => int.Parse(value, CultureInfo.InvariantCulture)).ToArray();
            long duration = long.Parse(fields[5], CultureInfo.InvariantCulture);
            if (parts[0] < 0 || parts[0] > 65535 || parts.Skip(1).Any(value => Math.Abs((long)value) > 32767)
                || duration < 16) throw new ArgumentException("Invalid state sequence");
            end = checked(end + duration);
            return new Span(new GamepadInput {
                PlayerId = PlayerIndex.Player1, Buttons = (ControllerKeys)parts[0],
                LStick = new JoystickPosition { Dx = parts[1], Dy = parts[2] },
                RStick = new JoystickPosition { Dx = parts[3], Dy = parts[4] },
            }, end);
        }).ToArray();
    }

    public void Dispose()
    {
        Reset();
        _lifetime.Cancel();
        _client?.Dispose();
        _listener.Stop();
        if (Current == this) Current = null;
    }
}
