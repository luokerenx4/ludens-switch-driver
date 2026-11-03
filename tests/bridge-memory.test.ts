import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RSA_BRIDGE_CS = path.join(REPO_ROOT, "emulator", "RsaBridge.cs");
const DOTNET = process.env.RSA_DOTNET || "/Users/ame/2610dev/playness/artifacts/switch/dotnet/dotnet";

const WARMUP_FRAMES = 30;
const STRESS_FRAMES = 300;

const CS_PROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${RSA_BRIDGE_CS}" />
  </ItemGroup>
</Project>
`;

// Minimal stubs for every Ryujinx/Avalonia type RsaBridge.cs touches, plus the
// harness itself: reusable 1080p frame, 5 ms BeforePresent loop, sequential
// CAPTURE client, GC/RSS instrumentation.
const PROGRAM_CS = String.raw`
using System;
using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Ryujinx.Ava.Systems;
using Ryujinx.Graphics.GAL;

public static class Program
{
    public static int Main()
    {
        string outDir = Path.GetFullPath(Environment.GetEnvironmentVariable("RSA_MEMORY_OUTDIR")
            ?? Path.Combine(Path.GetTempPath(), "rsa-bridge-memory-" + Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(outDir);

        int port;
        using (TcpListener probe = new(IPAddress.Loopback, 0))
        {
            probe.Start();
            port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
        }

        using RsaBridge bridge = new(port);

        // ONE reusable 1920x1080 BGRA frame: the harness never reallocates it,
        // so all measured allocation comes from RsaBridge.cs itself.
        const int width = 1920, height = 1080;
        byte[] frameData = new byte[width * height * 4];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int o = (y * width + x) * 4;
                frameData[o] = (byte)(x & 0xFF);          // B
                frameData[o + 1] = (byte)(y & 0xFF);      // G
                frameData[o + 2] = (byte)((x ^ y) & 0xFF); // R
            }
        ScreenCaptureImageInfo info = new(width, height, true, frameData, false, true);
        StubRenderer renderer = new(bridge, info);

        // Background render loop: BeforePresent every 5ms for the whole run so
        // overlapping BeforePresent + CAPTURE races are exercised.
        using CancellationTokenSource renderStop = new();
        Task renderLoop = Task.Run(async () =>
        {
            while (!renderStop.IsCancellationRequested)
            {
                bridge.BeforePresent(renderer);
                try { await Task.Delay(5, renderStop.Token); } catch (TaskCanceledException) { break; }
            }
        });

        using TcpClient client = new();
        client.Connect(IPAddress.Loopback, port);
        using NetworkStream stream = client.GetStream();
        using StreamWriter writer = new(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        using StreamReader reader = new(stream, Encoding.UTF8);

        long Capture(string name)
        {
            string file = Path.Combine(outDir, name);
            writer.WriteLine("c" + name + "\tCAPTURE\t" + file);
            string reply = reader.ReadLine() ?? throw new IOException("bridge closed");
            string[] fields = reply.Split('\t');
            if (fields.Length < 3 || fields[1] != "OK") throw new IOException("CAPTURE failed: " + reply);
            return long.Parse(fields[2], CultureInfo.InvariantCulture);
        }

        // Warmup: frames so JIT tiers and caches settle before measuring.
        for (int i = 0; i < ${WARMUP_FRAMES}; i++) Capture("warm-" + i.ToString("000") + ".png");

        // Prime every per-core ArrayPool bucket the encoder rents from (the
        // 1920*1080 filter rows and PNG sink both round to the 8 MiB bucket),
        // touching pages so neither pool growth nor first-touch lands inside
        // the measured window.
        Parallel.For(0, Environment.ProcessorCount, _ =>
        {
            byte[] a = ArrayPool<byte>.Shared.Rent(8 * 1024 * 1024);
            byte[] b = ArrayPool<byte>.Shared.Rent(8 * 1024 * 1024);
            Array.Clear(a, 0, a.Length);
            Array.Clear(b, 0, b.Length);
            ArrayPool<byte>.Shared.Return(a);
            ArrayPool<byte>.Shared.Return(b);
        });
        GC.Collect();
        GC.WaitForPendingFinalizers();

        long allocBefore = GC.GetTotalAllocatedBytes(precise: true);
        long heapBefore = GC.GetTotalMemory(forceFullCollection: true);
        long rssBefore = Process.GetCurrentProcess().WorkingSet64;

        long captureTicks = 0;
        for (int i = 0; i < ${STRESS_FRAMES}; i++)
        {
            long started = Stopwatch.GetTimestamp();
            Capture("stress-" + i.ToString("0000") + ".png");
            captureTicks += Stopwatch.GetTimestamp() - started;
        }

        long allocAfter = GC.GetTotalAllocatedBytes(precise: true);
        long heapAfter = GC.GetTotalMemory(forceFullCollection: true);
        long rssAfter = Process.GetCurrentProcess().WorkingSet64;

        renderStop.Cancel();
        renderLoop.Wait();

        double avgCaptureMs = captureTicks * 1000.0 / Stopwatch.Frequency / ${STRESS_FRAMES};
        string metrics = string.Create(CultureInfo.InvariantCulture,
            $"{{\"frames\":${STRESS_FRAMES},\"allocatedBytesPerFrame\":{(allocAfter - allocBefore) / (double)${STRESS_FRAMES}:F1},\"heapDeltaMB\":{(heapAfter - heapBefore) / 1048576.0:F2},\"rssDeltaMB\":{(rssAfter - rssBefore) / 1048576.0:F2},\"avgCaptureMs\":{avgCaptureMs:F2},\"outDir\":\"{outDir}\"}}");
        Console.WriteLine("BRIDGE_MEMORY_METRICS " + metrics);
        return 0;
    }
}

internal sealed class StubRenderer : IRenderer
{
    private readonly RsaBridge _bridge;
    private readonly ScreenCaptureImageInfo _info;
    public StubRenderer(RsaBridge bridge, ScreenCaptureImageInfo info) { _bridge = bridge; _info = info; }
    public void BackgroundContextAction(Action action) => action();
    public void Screenshot() => _bridge.ScreenCaptured(_info);
}
`;

// ---- Stubs for Ryujinx/Avalonia namespaces referenced by RsaBridge.cs ----
const STUBS_CS = String.raw`
using System;
using System.Threading.Tasks;

namespace Ryujinx.Graphics.GAL
{
    public interface IRenderer
    {
        void BackgroundContextAction(Action action);
        void Screenshot();
    }
    public sealed record ScreenCaptureImageInfo(int Width, int Height, bool IsBgra, byte[] Data, bool FlipX, bool FlipY);
}

namespace Ryujinx.Common.Logging
{
    public enum LogClass { Application }
    public interface ILogger { void Print(LogClass classType, string message); }
    public static class Logger { public static ILogger Info; }
}

namespace Ryujinx.Ava.UI.Controls
{
    public sealed class SwkbdAppletDialog
    {
        public static SwkbdAppletDialog RsaActive;
        public void RsaCapture(string path) { }
        public void RsaInput(string operation, string value) { }
    }
}

namespace Avalonia.Threading
{
    public enum DispatcherPriority { Background }
    public sealed class Dispatcher
    {
        public static Dispatcher UIThread { get; } = new();
        public void Post(Action action, DispatcherPriority priority) => action();
        public Task<T> InvokeAsync<T>(Func<T> function) => Task.Run(function);
    }
}

namespace Ryujinx.HLE.HOS.Services.Hid
{
    public enum PlayerIndex { Player1 }
    [Flags]
    public enum ControllerKeys : ulong { None = 0 }
    public struct JoystickPosition { public int Dx; public int Dy; }
    public struct GamepadInput
    {
        public PlayerIndex PlayerId;
        public ControllerKeys Buttons;
        public JoystickPosition LStick;
        public JoystickPosition RStick;
    }
}
`;

interface Metrics {
  frames: number;
  allocatedBytesPerFrame: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  avgCaptureMs: number;
  outDir: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parsePng(file: string, buf: Buffer): { width: number; height: number; idat: Buffer } {
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file}: PNG signature`).toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    off += 12 + length;
  }
  return { width, height, idat: Buffer.concat(idat) };
}

describe("RsaBridge 1080p capture memory gate", () => {
  let metrics: Metrics;
  let files: string[];

  test(
    "harness compiles and runs the real RsaBridge.cs",
    async () => {
      const work = await mkdtemp(path.join(tmpdir(), "rsa-bridge-harness-"));
      const outDir = path.join(work, "captures");
      await mkdir(outDir);
      await writeFile(path.join(work, "Harness.csproj"), CS_PROJ);
      await writeFile(path.join(work, "Program.cs"), PROGRAM_CS);
      await writeFile(path.join(work, "Stubs.cs"), STUBS_CS);

      const build = spawnSync(DOTNET, ["build", "-c", "Release", "-v", "q", "--nologo"], { cwd: work, encoding: "utf8" });
      expect(build.status, `dotnet build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);

      const run = spawnSync(
        DOTNET,
        ["run", "-c", "Release", "--no-build", "--", ],
        { cwd: work, encoding: "utf8", env: { ...process.env, RSA_MEMORY_OUTDIR: outDir }, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
      );
      expect(run.status, `harness exited ${run.status}:\n${run.stdout}\n${run.stderr}`).toBe(0);
      const line = run.stdout.split("\n").find((l) => l.startsWith("BRIDGE_MEMORY_METRICS "));
      expect(line, "metrics line missing").toBeDefined();
      metrics = JSON.parse(line!.slice("BRIDGE_MEMORY_METRICS ".length));
      console.log("BRIDGE_MEMORY_METRICS", JSON.stringify(metrics));

      files = (await readdir(metrics.outDir)).filter((f) => f.endsWith(".png")).sort();
      expect(files.length).toBe(WARMUP_FRAMES + STRESS_FRAMES);
    },
    600_000,
  );

  test(
    "every captured PNG is a valid 1920x1080 image with a clean zlib stream (Adler-32 verified)",
    async () => {
      expect(files).toBeDefined();
      for (const name of files) {
        const buf = await readFile(path.join(metrics.outDir, name));
        const { width, height, idat } = parsePng(name, buf);
        expect(width, `${name}: IHDR width`).toBe(1920);
        expect(height, `${name}: IHDR height`).toBe(1080);
        // inflateSync verifies the entire zlib stream including the Adler-32 trailer.
        const raw = zlib.inflateSync(idat);
        expect(raw.length, `${name}: inflated size`).toBe(1080 * (1920 * 4 + 1));
      }
    },
    120_000,
  );

  test("memory gate: allocation ceiling per 1080p frame", () => {
    expect(metrics.allocatedBytesPerFrame, `allocatedBytesPerFrame ${metrics.allocatedBytesPerFrame} bytes/frame`).toBeLessThan(256 * 1024);
  });

  test("memory gate: managed heap growth", () => {
    expect(metrics.heapDeltaMB, `heapDeltaMB ${metrics.heapDeltaMB}`).toBeLessThan(32);
  });

  test("memory gate: working set growth", () => {
    expect(metrics.rssDeltaMB, `rssDeltaMB ${metrics.rssDeltaMB}`).toBeLessThan(64);
  });
});
