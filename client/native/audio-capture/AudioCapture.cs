// Captura o áudio do sistema MENOS o do Resenha (e dos processos filhos dele) e o de apps de voz
// como o Discord, usando o "process loopback" do Windows 10 2004+ / Windows 11. Sem isso, a stream
// pega também as vozes da call (do Resenha ou do Discord) e os amigos se escutam.
//
// O process loopback só aceita UM processo por captura (incluir ou excluir a árvore dele), então
// não dá para excluir dois apps de uma vez. Em vez disso: a cada segundo vemos quais processos têm
// uma sessão de áudio tocando, abrimos uma captura "só este processo" para cada um que não é o
// Resenha nem um app excluído, e mixamos tudo aqui.
//
// Uso: resenha-audio.exe --exclude-pid <pid> [--exclude-name Discord.exe ...]
// Saída: PCM float32 intercalado, 48 kHz estéreo, no stdout. "READY" no stderr quando começa.
// Termina quando o stdin fecha (o app saiu ou parou a transmissão).
//
// Compilado com o csc.exe do .NET Framework 4 que já vem no Windows (scripts/build-audio-helper.mjs),
// então fica restrito a C# 5.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Resenha
{
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    // O Windows exige que o callback seja "agile" (pode ser chamado de qualquer thread).
    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject
    {
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    // ---- sessões de áudio (quem está tocando som), só os métodos que usamos + os que vêm antes na vtable ----

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName(out IntPtr name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr eventContext);
        [PreserveSig] int GetIconPath(out IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr eventContext);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(IntPtr grouping, IntPtr eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier(out IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                operation.GetActivateResult(out Result, out Client);
            }
            catch (Exception e)
            {
                Result = Marshal.GetHRForException(e);
            }
            Done.Set();
        }
    }

    // Uma captura de process loopback, com um buffer próprio que o mixer vai esvaziando.
    class Source
    {
        public readonly int Pid;
        readonly IAudioClient client;
        readonly IAudioCaptureClient capture;
        readonly IntPtr evt;
        readonly bool isFloat;
        readonly Thread thread;
        volatile bool stopping;

        // em amostras intercaladas
        readonly float[] ring = new float[Program.SampleRate * Program.Channels]; // 1 s
        int read, count;
        bool primed;
        const int PrimeSamples = Program.SampleRate * Program.Channels * 2 / 100; // 20 ms
        const int MaxSamples = Program.SampleRate * Program.Channels / 10; // 100 ms
        const int TargetSamples = Program.SampleRate * Program.Channels * 4 / 100; // 40 ms

        Source(int pid, IAudioClient client, IAudioCaptureClient capture, IntPtr evt, bool isFloat)
        {
            Pid = pid;
            this.client = client;
            this.capture = capture;
            this.evt = evt;
            this.isFloat = isFloat;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        public static Source Open(int pid, int mode)
        {
            IAudioClient client = Program.Activate(pid, mode);
            if (client == null) throw new Exception("process loopback indisponível (precisa do Windows 10 2004 ou mais novo)");

            // Tenta float32; se o Windows recusar, pede PCM 16 bits e converte aqui.
            bool isFloat = true;
            int hr = Program.Initialize(client, true);
            if (hr < 0)
            {
                isFloat = false;
                hr = Program.Initialize(client, false);
            }
            if (hr < 0) throw new Exception("Initialize falhou: 0x" + hr.ToString("X8"));

            IntPtr evt = Program.CreateEvent(IntPtr.Zero, false, false, null);
            hr = client.SetEventHandle(evt);
            if (hr < 0) throw new Exception("SetEventHandle falhou: 0x" + hr.ToString("X8"));

            object service;
            hr = client.GetService(typeof(IAudioCaptureClient).GUID, out service);
            if (hr < 0) throw new Exception("GetService falhou: 0x" + hr.ToString("X8"));

            hr = client.Start();
            if (hr < 0) throw new Exception("Start falhou: 0x" + hr.ToString("X8"));
            return new Source(pid, client, (IAudioCaptureClient)service, evt, isFloat);
        }

        void Run()
        {
            var shorts = new short[0];
            var floats = new float[0];
            try
            {
                while (!stopping)
                {
                    Program.WaitForSingleObject(evt, 100);
                    uint packet;
                    while (!stopping && capture.GetNextPacketSize(out packet) >= 0 && packet > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpcPosition;
                        if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) < 0) break;

                        int samples = (int)frames * Program.Channels;
                        if (floats.Length < samples) floats = new float[samples];
                        if ((flags & Program.AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        {
                            Array.Clear(floats, 0, samples);
                        }
                        else if (isFloat)
                        {
                            Marshal.Copy(data, floats, 0, samples);
                        }
                        else
                        {
                            if (shorts.Length < samples) shorts = new short[samples];
                            Marshal.Copy(data, shorts, 0, samples);
                            for (int i = 0; i < samples; i++) floats[i] = shorts[i] / 32768f;
                        }
                        capture.ReleaseBuffer(frames);
                        Push(floats, samples);
                    }
                }
            }
            catch (Exception)
            {
                // processo alvo morreu ou o dispositivo sumiu: o poller tira esta fonte
            }
        }

        void Push(float[] data, int samples)
        {
            lock (ring)
            {
                int write = (read + count) % ring.Length;
                for (int i = 0; i < samples; i++)
                {
                    ring[write] = data[i];
                    write = (write + 1) % ring.Length;
                }
                count += samples;
                if (count > ring.Length)
                {
                    read = (read + count - ring.Length) % ring.Length;
                    count = ring.Length;
                }
            }
        }

        public void MixInto(float[] mix, int samples)
        {
            lock (ring)
            {
                // junta 20 ms antes de tocar, para engolir a variação de chegada dos pacotes
                if (!primed)
                {
                    if (count < PrimeSamples) return;
                    primed = true;
                }
                // não deixa o atraso crescer: passou de 100 ms na fila, pula para 40 ms
                if (count > MaxSamples)
                {
                    int drop = count - TargetSamples;
                    read = (read + drop) % ring.Length;
                    count -= drop;
                }
                int n = Math.Min(samples, count);
                for (int i = 0; i < n; i++)
                {
                    mix[i] += ring[read];
                    read = (read + 1) % ring.Length;
                }
                count -= n;
                if (n < samples) primed = false;
            }
        }

        public void Close()
        {
            stopping = true;
            thread.Join(500);
            try { client.Stop(); } catch { }
            Program.CloseHandle(evt);
            try { Marshal.ReleaseComObject(capture); } catch { }
            try { Marshal.ReleaseComObject(client); } catch { }
        }
    }

    static class Program
    {
        public const int SampleRate = 48000;
        public const int Channels = 2;

        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        public const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        const ushort VT_BLOB = 65;
        const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
        const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
        const int PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;
        const int AudioSessionStateActive = 1;
        const uint TH32CS_SNAPPROCESS = 0x2;

        [DllImport("Mmdevapi.dll", ExactSpelling = true)]
        static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll")]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode)]
        static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)]
        static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("winmm.dll")]
        static extern uint timeBeginPeriod(uint period);

        static int selfPid;
        static readonly HashSet<string> excludeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static readonly List<Source> sources = new List<Source>();
        // processos em que a ativação falhou; não tenta de novo enquanto estiverem vivos
        static readonly HashSet<int> failed = new HashSet<int>();

        static int Fail(string message)
        {
            Console.Error.WriteLine(message);
            return 1;
        }

        [MTAThread]
        static int Main(string[] args)
        {
            for (int i = 0; i + 1 < args.Length; i++)
            {
                if (args[i] == "--exclude-pid") int.TryParse(args[i + 1], out selfPid);
                else if (args[i] == "--exclude-name") excludeNames.Add(args[i + 1]);
            }
            if (selfPid <= 0) return Fail("uso: resenha-audio.exe --exclude-pid <pid> [--exclude-name <exe> ...]");

            // Quando o app fecha o stdin (ou morre), encerra.
            var watcher = new Thread(delegate ()
            {
                var stdin = Console.OpenStandardInput();
                var buf = new byte[64];
                try { while (stdin.Read(buf, 0, buf.Length) > 0) { } } catch { }
                Environment.Exit(0);
            });
            watcher.IsBackground = true;
            watcher.Start();

            bool perProcess = true;
            try
            {
                Marshal.ReleaseComObject(OpenSessionManager());
                // testa se o process loopback existe antes de prometer READY
                var probe = Activate(selfPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
                if (probe == null) throw new Exception("process loopback indisponível");
                Marshal.ReleaseComObject(probe);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("sessões de áudio indisponíveis (" + e.Message + "); excluindo só o Resenha");
                perProcess = false;
            }

            if (!perProcess)
            {
                // modo antigo: uma captura de tudo menos o Resenha (o Discord vaza)
                try
                {
                    sources.Add(Source.Open(selfPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE));
                }
                catch (Exception e)
                {
                    return Fail("ativação falhou: " + e.Message);
                }
            }
            else
            {
                Sync();
                var poller = new Thread(delegate ()
                {
                    while (true)
                    {
                        Thread.Sleep(1000);
                        try { Sync(); }
                        catch (Exception e) { Console.Error.WriteLine("sync: " + e.Message); }
                    }
                });
                poller.IsBackground = true;
                poller.Start();
            }

            Console.Error.WriteLine("READY");
            Console.Error.Flush();
            return Mix();
        }

        // Relógio próprio: a cada ~10 ms soma o que cada fonte tem e escreve no stdout.
        static int Mix()
        {
            timeBeginPeriod(1);
            var stdout = Console.OpenStandardOutput();
            var mix = new float[0];
            var bytes = new byte[0];
            var clock = Stopwatch.StartNew();
            long produced = 0;
            try
            {
                while (true)
                {
                    Thread.Sleep(10);
                    long due = (long)(clock.Elapsed.TotalSeconds * SampleRate);
                    // travou por muito tempo: não despeja um monte de silêncio de uma vez
                    int frames = (int)Math.Min(due - produced, SampleRate / 10);
                    produced = due;
                    if (frames <= 0) continue;

                    int samples = frames * Channels;
                    if (mix.Length < samples) mix = new float[samples];
                    Array.Clear(mix, 0, samples);
                    Source[] current;
                    lock (sources) current = sources.ToArray();
                    foreach (var source in current) source.MixInto(mix, samples);
                    for (int i = 0; i < samples; i++)
                    {
                        if (mix[i] > 1f) mix[i] = 1f;
                        else if (mix[i] < -1f) mix[i] = -1f;
                    }

                    int size = samples * 4;
                    if (bytes.Length < size) bytes = new byte[size];
                    Buffer.BlockCopy(mix, 0, bytes, 0, size);
                    stdout.Write(bytes, 0, size);
                    stdout.Flush();
                }
            }
            catch (IOException)
            {
                // o app fechou o pipe
                return 0;
            }
        }

        static IAudioSessionManager2 OpenSessionManager()
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice device = null;
            try
            {
                int hr = enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 0 /* eConsole */, out device);
                if (hr < 0) throw new Exception("GetDefaultAudioEndpoint: 0x" + hr.ToString("X8"));
                object manager;
                hr = device.Activate(typeof(IAudioSessionManager2).GUID, 23 /* CLSCTX_ALL */, IntPtr.Zero, out manager);
                if (hr < 0) throw new Exception("IMMDevice.Activate: 0x" + hr.ToString("X8"));
                return (IAudioSessionManager2)manager;
            }
            finally
            {
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }

        // Ajusta as capturas para os processos que estão tocando som agora. Reabre o gerenciador de
        // sessões toda vez para acompanhar a troca do dispositivo de saída padrão.
        static void Sync()
        {
            var parents = new Dictionary<int, int>();
            var names = new Dictionary<int, string>();
            Snapshot(parents, names);

            // processos com sessão ativa + os que já capturamos e continuam vivos
            var manager = OpenSessionManager();
            List<int> active;
            try { active = ActiveSessionPids(manager); }
            finally { Marshal.ReleaseComObject(manager); }
            var candidates = new HashSet<int>(active);
            lock (sources) foreach (var s in sources) if (parents.ContainsKey(s.Pid)) candidates.Add(s.Pid);
            failed.RemoveWhere(pid => !parents.ContainsKey(pid));

            // quem tem o Resenha ou um app excluído embaixo não pode ser capturado com a árvore inteira
            // (ex.: o explorer.exe); os filhos dele que tocam som entram cada um por si
            var excludedAncestors = new HashSet<int>();
            foreach (var pid in parents.Keys)
            {
                if (!IsExcludedItself(pid, names)) continue;
                int p = pid;
                for (int depth = 0; depth < 64 && parents.TryGetValue(p, out p) && p > 0; depth++)
                    if (!excludedAncestors.Add(p)) break;
            }

            var usable = new HashSet<int>();
            foreach (var pid in candidates)
                if (!IsExcluded(pid, parents, names) && !excludedAncestors.Contains(pid)) usable.Add(pid);

            // a captura de um processo já inclui os filhos dele: não captura o filho de novo
            var wanted = new HashSet<int>();
            foreach (var pid in usable)
            {
                bool covered = false;
                int p = pid;
                for (int depth = 0; depth < 64 && parents.TryGetValue(p, out p) && p > 0; depth++)
                {
                    if (usable.Contains(p)) { covered = true; break; }
                }
                if (!covered) wanted.Add(pid);
            }

            var stale = new List<Source>();
            var running = new HashSet<int>();
            lock (sources)
            {
                for (int i = sources.Count - 1; i >= 0; i--)
                {
                    if (wanted.Contains(sources[i].Pid)) running.Add(sources[i].Pid);
                    else { stale.Add(sources[i]); sources.RemoveAt(i); }
                }
            }
            foreach (var s in stale) s.Close();

            foreach (var pid in wanted)
            {
                if (running.Contains(pid) || failed.Contains(pid)) continue;
                try
                {
                    var source = Source.Open(pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE);
                    lock (sources) sources.Add(source);
                }
                catch (Exception e)
                {
                    failed.Add(pid);
                    string name;
                    names.TryGetValue(pid, out name);
                    Console.Error.WriteLine("captura de " + name + " (" + pid + ") falhou: " + e.Message);
                }
            }
        }

        static bool IsExcludedItself(int pid, Dictionary<int, string> names)
        {
            string name;
            return pid == selfPid || (names.TryGetValue(pid, out name) && excludeNames.Contains(name));
        }

        // o processo ou algum ancestral é o Resenha ou um app excluído
        static bool IsExcluded(int pid, Dictionary<int, int> parents, Dictionary<int, string> names)
        {
            int p = pid;
            for (int depth = 0; depth < 64 && p > 0; depth++)
            {
                if (IsExcludedItself(p, names)) return true;
                if (!parents.TryGetValue(p, out p)) break;
            }
            return false;
        }

        static List<int> ActiveSessionPids(IAudioSessionManager2 manager)
        {
            var pids = new List<int>();
            IAudioSessionEnumerator sessions;
            if (manager.GetSessionEnumerator(out sessions) < 0) return pids;
            try
            {
                int count;
                sessions.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    object session;
                    if (sessions.GetSession(i, out session) < 0 || session == null) continue;
                    try
                    {
                        var control = (IAudioSessionControl2)session;
                        int state;
                        uint pid;
                        if (control.GetState(out state) >= 0 && state == AudioSessionStateActive
                            && control.GetProcessId(out pid) >= 0 && pid != 0)
                            pids.Add((int)pid);
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(session);
                    }
                }
            }
            finally
            {
                Marshal.ReleaseComObject(sessions);
            }
            return pids;
        }

        static void Snapshot(Dictionary<int, int> parents, Dictionary<int, string> names)
        {
            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == new IntPtr(-1)) return;
            try
            {
                var entry = new ProcessEntry();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                if (!Process32First(snap, ref entry)) return;
                do
                {
                    int pid = (int)entry.th32ProcessID;
                    // o pai pode já ter morrido e o PID ter sido reaproveitado; o limite de profundidade evita laço
                    parents[pid] = pid == (int)entry.th32ParentProcessID ? 0 : (int)entry.th32ParentProcessID;
                    names[pid] = entry.szExeFile;
                } while (Process32Next(snap, ref entry));
            }
            finally
            {
                CloseHandle(snap);
            }
        }

        public static IAudioClient Activate(int pid, int mode)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType; { TargetProcessId; ProcessLoopbackMode } }
            IntPtr activation = Marshal.AllocHGlobal(12);
            // PROPVARIANT do tipo VT_BLOB apontando para os parâmetros acima
            IntPtr variant = Marshal.AllocHGlobal(24);
            try
            {
                Marshal.WriteInt32(activation, 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK);
                Marshal.WriteInt32(activation, 4, pid);
                Marshal.WriteInt32(activation, 8, mode);

                for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(variant, i, 0);
                Marshal.WriteInt16(variant, 0, (short)VT_BLOB);
                Marshal.WriteInt32(variant, 8, 12);
                Marshal.WriteIntPtr(variant, IntPtr.Size == 8 ? 16 : 12, activation);

                var handler = new CompletionHandler();
                IActivateAudioInterfaceAsyncOperation operation;
                int hr = ActivateAudioInterfaceAsync(
                    "VAD\\Process_Loopback", typeof(IAudioClient).GUID, variant, handler, out operation);
                if (hr < 0) throw new Exception("ActivateAudioInterfaceAsync: 0x" + hr.ToString("X8"));
                if (!handler.Done.WaitOne(5000)) throw new Exception("tempo esgotado");
                if (handler.Result < 0) throw new Exception("ActivateCompleted: 0x" + handler.Result.ToString("X8"));
                GC.KeepAlive(operation);
                return handler.Client as IAudioClient;
            }
            finally
            {
                Marshal.FreeHGlobal(variant);
                Marshal.FreeHGlobal(activation);
            }
        }

        public static int Initialize(IAudioClient client, bool asFloat)
        {
            int bits = asFloat ? 32 : 16;
            int blockAlign = Channels * bits / 8;
            // WAVEFORMATEX
            IntPtr format = Marshal.AllocHGlobal(18);
            try
            {
                Marshal.WriteInt16(format, 0, (short)(asFloat ? 3 : 1)); // IEEE_FLOAT / PCM
                Marshal.WriteInt16(format, 2, (short)Channels);
                Marshal.WriteInt32(format, 4, SampleRate);
                Marshal.WriteInt32(format, 8, SampleRate * blockAlign);
                Marshal.WriteInt16(format, 12, (short)blockAlign);
                Marshal.WriteInt16(format, 14, (short)bits);
                Marshal.WriteInt16(format, 16, 0);
                uint flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                // buffer de 20 ms
                return client.Initialize(0, flags, 200000, 0, format, IntPtr.Zero);
            }
            finally
            {
                Marshal.FreeHGlobal(format);
            }
        }
    }
}
