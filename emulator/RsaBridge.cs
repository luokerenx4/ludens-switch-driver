// Compiled into the pinned Ryubing build by build.sh. No game memory access.
using Ryujinx.Graphics.GAL;
using Ryujinx.Common.Logging;
using Ryujinx.Ava.UI.Controls;
using Avalonia.Threading;
using Ryujinx.HLE.HOS.Services.Hid;
using System;
using System.Buffers;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
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
    private long _lastCaptureRequestAt;
    private long _lastDeliveredFrame;
    private int _inFlightCaptures;
    private readonly Queue<(long Frame, long QueuedAt)> _pendingScreenshots = new();
    private EncodedFrame _latestEncoded;
    private static readonly uint[] Crc32Table = CreateCrc32Table();

    private sealed record EncodedFrame(long Frame, byte[] Bytes, int Length, long QueuedAt, long CallbackAt, long WorkerAt, long EncodedAt);

    private sealed record Span(GamepadInput State, long EndMs);

    [System.Runtime.CompilerServices.ModuleInitializer]
    internal static void InitializeBridgeEnvironment()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RSA_BRIDGE_PORT")) &&
            Environment.GetEnvironmentVariable("LUDENS_BRIDGE_PORT") is { Length: > 0 } port)
        {
            Environment.SetEnvironmentVariable("RSA_BRIDGE_PORT", port);
        }
    }

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
        public bool Claimed;
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
        long frame;
        lock (_gate)
        {
            frame = ++_frame;
            // Never spin screenshotting while a fresh unconsumed frame is already
            // encoded and waiting; only shoot when a CAPTURE needs newer pixels.
            bool wantsFrame = _capture is { Claimed: false } ||
                ((_latestEncoded == null || _latestEncoded.Frame <= _lastDeliveredFrame) &&
                    (_lastCaptureRequestAt != 0 && Stopwatch.GetElapsedTime(_lastCaptureRequestAt).TotalMilliseconds < 500));
            bool shouldCapture = SwkbdAppletDialog.RsaActive == null && _inFlightCaptures < 2 && wantsFrame;
            if (!shouldCapture) return;
            _inFlightCaptures++;
        }

        // The full renderer queues this action behind older presentations and
        // waits for it before the GPU thread submits the next Present. Never
        // hold _gate across that wait: capture callbacks also acquire it.
        renderer.BackgroundContextAction(() =>
        {
            lock (_gate)
            {
                if (SwkbdAppletDialog.RsaActive != null)
                {
                    _inFlightCaptures--;
                    return;
                }
                _pendingScreenshots.Enqueue((frame, Stopwatch.GetTimestamp()));
                renderer.Screenshot();
            }
        });
    }

    public bool ScreenCaptured(ScreenCaptureImageInfo image)
    {
        long callbackAt = Stopwatch.GetTimestamp();
        (long Frame, long QueuedAt) pending;
        lock (_gate)
        {
            if (!_pendingScreenshots.TryDequeue(out pending)) return false;
        }

        // Encode in parallel with subsequent GPU presents and screenshot callbacks.
        _ = Task.Run(() =>
        {
            long workerAt = Stopwatch.GetTimestamp();
            Capture waiting = null;
            byte[] pngBuffer = null;
            try
            {
                pngBuffer = EncodePng(image, out int pngLength);
                long encodedAt = Stopwatch.GetTimestamp();
                bool cached = false;
                lock (_gate)
                {
                    if (_capture is { Claimed: false } && SwkbdAppletDialog.RsaActive == null && pending.Frame > _lastDeliveredFrame)
                    {
                        waiting = _capture;
                        waiting.Claimed = true;
                        _capture = null;
                        _lastDeliveredFrame = pending.Frame;
                    }
                    else if (pending.Frame > _lastDeliveredFrame && (_latestEncoded == null || pending.Frame > _latestEncoded.Frame))
                    {
                        if (_latestEncoded != null) ArrayPool<byte>.Shared.Return(_latestEncoded.Bytes);
                        _latestEncoded = new EncodedFrame(pending.Frame, pngBuffer, pngLength, pending.QueuedAt, callbackAt, workerAt, encodedAt);
                        cached = true;
                    }
                }
                if (cached) pngBuffer = null;
                if (waiting != null)
                {
                    WritePngFile(waiting.Path, pngBuffer, pngLength);
                    long completedAt = Stopwatch.GetTimestamp();
                    waiting.Done.TrySetResult([pending.Frame.ToString(CultureInfo.InvariantCulture)]);
                    LogCapture(waiting, "game", pending.Frame, completedAt, writer =>
                    {
                        writer.WriteNumber("receivedToQueuedMs", Stopwatch.GetElapsedTime(waiting.ReceivedAt, pending.QueuedAt).TotalMilliseconds);
                        writer.WriteNumber("queuedToCallbackMs", Stopwatch.GetElapsedTime(pending.QueuedAt, callbackAt).TotalMilliseconds);
                        writer.WriteNumber("callbackToWorkerMs", Stopwatch.GetElapsedTime(callbackAt, workerAt).TotalMilliseconds);
                        writer.WriteNumber("encodeSaveMs", Stopwatch.GetElapsedTime(workerAt, completedAt).TotalMilliseconds);
                    });
                }
                if (pngBuffer != null)
                {
                    ArrayPool<byte>.Shared.Return(pngBuffer);
                    pngBuffer = null;
                }
            }
            catch (Exception error) { waiting?.Done.TrySetException(error); }
            finally
            {
                if (pngBuffer != null) ArrayPool<byte>.Shared.Return(pngBuffer);
                lock (_gate) _inFlightCaptures--;
            }
        });
        return true;
    }

    // Encodes into ArrayPool-backed buffers only: one rented filter buffer and
    // one rented PNG buffer per frame, so a 1080p frame costs no fresh LOH
    // allocations. Filtering runs in parallel over disjoint row blocks; deflate
    // writes once, straight into the IDAT region of the final PNG buffer, so its
    // native zlib state is released on Dispose instead of piling up until
    // finalizers run. The returned buffer is pool-owned; callers must return it
    // to ArrayPool<byte>.Shared once the PNG bytes are consumed.
    private static byte[] EncodePng(ScreenCaptureImageInfo image, out int pngLength)
    {
        const int chunks = 6;
        int width = image.Width;
        int height = image.Height;
        int rowsPerChunk = (height + chunks - 1) / chunks;
        int bytesPerRow = width * 4;
        int filteredLength = height * (bytesPerRow + 1);
        byte[] source = image.Data;
        byte[] filtered = ArrayPool<byte>.Shared.Rent(filteredLength);
        try
        {
            uint[] stripS1 = new uint[chunks];
            uint[] stripS2 = new uint[chunks];
            Parallel.For(0, chunks, chunk =>
            {
                int startY = chunk * rowsPerChunk;
                int endY = Math.Min(height, startY + rowsPerChunk);
                if (startY >= endY) return;
                uint s1 = 0;
                uint s2 = 0;
                int adlerBlock = 0;

                for (int y = startY; y < endY; y++)
                {
                    int srcY = image.FlipY ? height - 1 - y : y;
                    int sourceRow = srcY * bytesPerRow;
                    int outputOffset = y * (bytesPerRow + 1);
                    filtered[outputOffset++] = 1;
                    byte prevR = 0, prevG = 0, prevB = 0, prevA = 0;
                    for (int x = 0; x < width; x++)
                    {
                        int srcX = image.FlipX ? width - 1 - x : x;
                        int sourceOffset = sourceRow + srcX * 4;
                        byte r, g, b;
                        if (image.IsBgra)
                        {
                            b = source[sourceOffset];
                            g = source[sourceOffset + 1];
                            r = source[sourceOffset + 2];
                        }
                        else
                        {
                            r = source[sourceOffset];
                            g = source[sourceOffset + 1];
                            b = source[sourceOffset + 2];
                        }
                        const byte a = 255;
                        filtered[outputOffset++] = (byte)(r - prevR);
                        filtered[outputOffset++] = (byte)(g - prevG);
                        filtered[outputOffset++] = (byte)(b - prevB);
                        filtered[outputOffset++] = (byte)(a - prevA);
                        prevR = r;
                        prevG = g;
                        prevB = b;
                        prevA = a;
                    }

                    int rowEnd = outputOffset;
                    for (int i = rowEnd - bytesPerRow - 1; i < rowEnd; i++)
                    {
                        s1 += filtered[i];
                        s2 += s1;
                        if (++adlerBlock == 5552)
                        {
                            s1 %= 65521;
                            s2 %= 65521;
                            adlerBlock = 0;
                        }
                    }
                }
                stripS1[chunk] = s1 % 65521;
                stripS2[chunk] = s2 % 65521;
            });

            uint adler1 = 1;
            uint adler2 = 0;
            for (int chunk = 0; chunk < chunks; chunk++)
            {
                int startY = chunk * rowsPerChunk;
                int endY = Math.Min(height, startY + rowsPerChunk);
                if (startY >= endY) continue;
                long length = (long)(endY - startY) * (bytesPerRow + 1);
                adler2 = (uint)((adler2 + (ulong)(length % 65521) * adler1 + stripS2[chunk]) % 65521);
                adler1 = (adler1 + stripS1[chunk]) % 65521;
            }

            // One pooled PNG buffer sized for the worst-case stored-block escape;
            // deflate writes straight into its IDAT payload region.
            byte[] png = ArrayPool<byte>.Shared.Rent(63 + 1024 + filteredLength);
            try
            {
                png[0] = 137; png[1] = 80; png[2] = 78; png[3] = 71;
                png[4] = 13; png[5] = 10; png[6] = 26; png[7] = 10;
                WriteUInt32(png, 8, 13);
                png[12] = (byte)'I'; png[13] = (byte)'H'; png[14] = (byte)'D'; png[15] = (byte)'R';
                WriteUInt32(png, 16, (uint)width);
                WriteUInt32(png, 20, (uint)height);
                png[24] = 8; png[25] = 6; png[26] = 0; png[27] = 0; png[28] = 0;
                WriteUInt32(png, 29, Crc32(png.AsSpan(12, 17)));
                png[37] = (byte)'I'; png[38] = (byte)'D'; png[39] = (byte)'A'; png[40] = (byte)'T';
                png[41] = 0x78;
                png[42] = 0x01;
                // Rent-backed sink rooted at the IDAT payload: the ctor treats
                // count as preexisting content, but a fresh stream's Position
                // starts at its origin, so deflate overwrites in place from the
                // first payload byte; overflow throws instead of reallocating.
                MemoryStream sink = new(png, 43, png.Length - 43, writable: true, publiclyVisible: true);
                using (DeflateStream deflate = new(sink, CompressionLevel.Fastest, leaveOpen: true))
                {
                    deflate.Write(filtered, 0, filteredLength);
                }
                // MemoryStream.Position is origin-relative: bytes written so far.
                int compressedLength = (int)sink.Position;
                int idatPayloadLength = 6 + compressedLength;
                WriteUInt32(png, 33, (uint)idatPayloadLength);
                WriteUInt32(png, 43 + compressedLength, (adler2 << 16) | adler1);
                int crcOffset = 47 + compressedLength;
                WriteUInt32(png, crcOffset, Crc32(png.AsSpan(37, 4 + idatPayloadLength)));
                int iendOffset = crcOffset + 4;
                WriteUInt32(png, iendOffset, 0);
                png[iendOffset + 4] = (byte)'I'; png[iendOffset + 5] = (byte)'E'; png[iendOffset + 6] = (byte)'N'; png[iendOffset + 7] = (byte)'D';
                WriteUInt32(png, iendOffset + 8, Crc32(png.AsSpan(iendOffset + 4, 4)));
                pngLength = iendOffset + 12;
                return png;
            }
            catch
            {
                ArrayPool<byte>.Shared.Return(png);
                throw;
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(filtered);
        }
    }

    private static void WritePngFile(string path, byte[] buffer, int length)
    {
        using FileStream stream = new(path, FileMode.Create, FileAccess.Write, FileShare.None);
        stream.Write(buffer, 0, length);
    }

    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        uint crc = 0xFFFFFFFFu;
        foreach (byte value in data)
        {
            crc = Crc32Table[(crc ^ value) & 0xFF] ^ (crc >> 8);
        }
        return crc ^ 0xFFFFFFFFu;
    }

    private static void WriteUInt32(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static uint[] CreateCrc32Table()
    {
        uint[] table = new uint[256];
        for (uint i = 0; i < table.Length; i++)
        {
            uint crc = i;
            for (int bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? 0xEDB88320u ^ (crc >> 1) : crc >> 1;
            table[i] = crc;
        }
        return table;
    }

    // Foreground Switch software keyboards pause game presentation. Capture the
    // actual Avalonia dialog instead, never a desktop-wide screenshot or game RAM.
    public void CaptureDialog()
    {
        Dispatcher.UIThread.Post(() =>
        {
            lock (_gate)
            {
                if (_capture is not { Claimed: false } || SwkbdAppletDialog.RsaActive == null) return;
                Capture capture = _capture;
                capture.Claimed = true;
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
            if (_latestEncoded != null)
            {
                ArrayPool<byte>.Shared.Return(_latestEncoded.Bytes);
                _latestEncoded = null;
            }
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
                _lastCaptureRequestAt = capture.ReceivedAt;
                if (SwkbdAppletDialog.RsaActive == null && _latestEncoded != null && _latestEncoded.Frame > _lastDeliveredFrame &&
                    Stopwatch.GetElapsedTime(_latestEncoded.EncodedAt, capture.ReceivedAt).TotalMilliseconds < 100)
                {
                    EncodedFrame cached = _latestEncoded;
                    _latestEncoded = null;
                    _lastDeliveredFrame = cached.Frame;
                    capture.Claimed = true;
                    _capture = capture;
                    _ = Task.Run(() =>
                    {
                        try
                        {
                            WritePngFile(capture.Path, cached.Bytes, cached.Length);
                            long completedAt = Stopwatch.GetTimestamp();
                            capture.Done.TrySetResult([cached.Frame.ToString(CultureInfo.InvariantCulture)]);
                            LogCapture(capture, "game", cached.Frame, completedAt, writer =>
                            {
                                writer.WriteNumber("receivedToQueuedMs", Stopwatch.GetElapsedTime(capture.ReceivedAt, cached.QueuedAt).TotalMilliseconds);
                                writer.WriteNumber("queuedToCallbackMs", Stopwatch.GetElapsedTime(cached.QueuedAt, cached.CallbackAt).TotalMilliseconds);
                                writer.WriteNumber("callbackToWorkerMs", Stopwatch.GetElapsedTime(cached.CallbackAt, cached.WorkerAt).TotalMilliseconds);
                                writer.WriteNumber("encodeSaveMs", Stopwatch.GetElapsedTime(cached.WorkerAt, completedAt).TotalMilliseconds);
                            });
                        }
                        catch (Exception error) { capture.Done.TrySetException(error); }
                        finally { ArrayPool<byte>.Shared.Return(cached.Bytes); }
                    });
                }
                else
                {
                    _capture = capture;
                    CaptureDialog();
                }
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
