// Captura o áudio do sistema MENOS o do Resenha (e dos processos filhos dele), usando o
// "process loopback" do Windows 10 2004+ / Windows 11. Sem isso, o loopback do Electron pega
// também as vozes da call que o app está tocando, e os amigos se escutam pela stream.
//
// Uso: resenha-audio.exe --exclude-pid <pid>
// Saída: PCM float32 intercalado, 48 kHz estéreo, no stdout. "READY" no stderr quando começa.
// Termina quando o stdin fecha (o app saiu ou parou a transmissão).
//
// Compilado com o csc.exe do .NET Framework 4 que já vem no Windows (scripts/build-audio-helper.mjs),
// então fica restrito a C# 5.

using System;
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

    static class Program
    {
        const int SampleRate = 48000;
        const int Channels = 2;

        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        const ushort VT_BLOB = 65;
        const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
        const int PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;

        [DllImport("Mmdevapi.dll", ExactSpelling = true)]
        static extern int ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll")]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        static int Fail(string message)
        {
            Console.Error.WriteLine(message);
            return 1;
        }

        [MTAThread]
        static int Main(string[] args)
        {
            int excludePid = 0;
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == "--exclude-pid") int.TryParse(args[i + 1], out excludePid);
            if (excludePid <= 0) return Fail("uso: resenha-audio.exe --exclude-pid <pid>");

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

            IAudioClient client;
            try
            {
                client = Activate(excludePid);
            }
            catch (Exception e)
            {
                return Fail("ativação falhou: " + e.Message);
            }
            if (client == null) return Fail("process loopback indisponível (precisa do Windows 10 2004 ou mais novo)");

            // Tenta float32; se o Windows recusar, pede PCM 16 bits e converte aqui.
            bool isFloat = true;
            int hr = Initialize(client, true);
            if (hr < 0)
            {
                isFloat = false;
                hr = Initialize(client, false);
            }
            if (hr < 0) return Fail("Initialize falhou: 0x" + hr.ToString("X8"));

            IntPtr evt = CreateEvent(IntPtr.Zero, false, false, null);
            hr = client.SetEventHandle(evt);
            if (hr < 0) return Fail("SetEventHandle falhou: 0x" + hr.ToString("X8"));

            object service;
            hr = client.GetService(typeof(IAudioCaptureClient).GUID, out service);
            if (hr < 0) return Fail("GetService falhou: 0x" + hr.ToString("X8"));
            var capture = (IAudioCaptureClient)service;

            hr = client.Start();
            if (hr < 0) return Fail("Start falhou: 0x" + hr.ToString("X8"));
            Console.Error.WriteLine("READY");
            Console.Error.Flush();

            var stdout = Console.OpenStandardOutput();
            var bytes = new byte[0];
            var shorts = new short[0];
            var floats = new float[0];

            try
            {
                while (true)
                {
                    WaitForSingleObject(evt, 200);
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) >= 0 && packet > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpcPosition;
                        if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) < 0) break;

                        int samples = (int)frames * Channels;
                        int size = samples * 4;
                        if (bytes.Length < size) bytes = new byte[size];
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        {
                            Array.Clear(bytes, 0, size);
                        }
                        else if (isFloat)
                        {
                            Marshal.Copy(data, bytes, 0, size);
                        }
                        else
                        {
                            if (shorts.Length < samples) shorts = new short[samples];
                            if (floats.Length < samples) floats = new float[samples];
                            Marshal.Copy(data, shorts, 0, samples);
                            for (int i = 0; i < samples; i++) floats[i] = shorts[i] / 32768f;
                            Buffer.BlockCopy(floats, 0, bytes, 0, size);
                        }
                        capture.ReleaseBuffer(frames);
                        stdout.Write(bytes, 0, size);
                    }
                    stdout.Flush();
                }
            }
            catch (IOException)
            {
                // o app fechou o pipe
                return 0;
            }
        }

        static IAudioClient Activate(int excludePid)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType; { TargetProcessId; ProcessLoopbackMode } }
            IntPtr activation = Marshal.AllocHGlobal(12);
            // PROPVARIANT do tipo VT_BLOB apontando para os parâmetros acima
            IntPtr variant = Marshal.AllocHGlobal(24);
            try
            {
                Marshal.WriteInt32(activation, 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK);
                Marshal.WriteInt32(activation, 4, excludePid);
                Marshal.WriteInt32(activation, 8, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);

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

        static int Initialize(IAudioClient client, bool asFloat)
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
