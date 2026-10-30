$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# This is a fixed, shipped broker. Invocation data is JSON on stdin, not source.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class JarelaSkillJob {
    [StructLayout(LayoutKind.Sequential)] struct SA {
        public int length; public IntPtr descriptor; public int inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI {
        public int cb; public string reserved; public string desktop; public string title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorking, maxWorking; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits basic; public IO io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime, kernelTime, periodUser, periodKernel;
        public uint faults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
        ref SIX startup, out PI info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetWindowsDirectory(StringBuilder directory, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr file, byte[] bytes, uint count, out uint written, IntPtr overlapped);

    static void Check(bool success) {
        if (!success) throw new InvalidOperationException("Job broker OS operation failed");
    }
    static string Quote(string value) {
        StringBuilder text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append(c); }
            else { text.Append('\\', slashes); text.Append(c); }
            slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"');
        return text.ToString();
    }
    static bool Empty(IntPtr job) {
        Accounting state;
        Check(QueryInformationJobObject(job, 1, out state, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return state.activeProcesses == 0;
    }
    public static void Run(string executable, string[] args, string cwd, string stdinBase64, string pipe) {
        using (NamedPipeClientStream control = new NamedPipeClientStream(".", pipe, PipeDirection.Out)) {
            control.Connect(5000);
            using (StreamWriter messages = new StreamWriter(control, new UTF8Encoding(false))) {
                messages.AutoFlush = true;
                IntPtr job = IntPtr.Zero, guard = IntPtr.Zero, read = IntPtr.Zero, write = IntPtr.Zero;
                IntPtr list = IntPtr.Zero, handles = IntPtr.Zero, jobList = IntPtr.Zero, environment = IntPtr.Zero;
                PI child = new PI();
                bool assigned = false, started = false, listReady = false;
                try {
                    job = CreateJobObject(IntPtr.Zero, null);
                    Check(job != IntPtr.Zero);
                    ExtendedLimits limits = new ExtendedLimits();
                    limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
                    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                    guard = CreateJobObject(IntPtr.Zero, null);
                    Check(guard != IntPtr.Zero);
                    Check(SetInformationJobObject(guard, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
                    SA security = new SA();
                    security.length = Marshal.SizeOf(typeof(SA)); security.inherit = 1;
                    Check(CreatePipe(out read, out write, ref security, 0));
                    Check(SetHandleInformation(write, 1, 0));
                    IntPtr output = GetStdHandle(-11), error = GetStdHandle(-12);
                    Check(SetHandleInformation(output, 1, 1));
                    Check(SetHandleInformation(error, 1, 1));
                    IntPtr size = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                    list = Marshal.AllocHGlobal(size);
                    Check(InitializeProcThreadAttributeList(list, 2, 0, ref size));
                    listReady = true;
                    handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
                    Marshal.WriteIntPtr(handles, 0, read);
                    Marshal.WriteIntPtr(handles, IntPtr.Size, output);
                    Marshal.WriteIntPtr(handles, IntPtr.Size * 2, error);
                    Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles,
                        new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
                    // Windows 10+ atomic outer-job assignment closes the broker
                    // crash window between CreateProcess and explicit inner-job
                    // assignment. Even the suspended process is always owned.
                    jobList = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(jobList, guard);
                    Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000D), jobList,
                        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
                    SIX startup = new SIX();
                    startup.si.cb = Marshal.SizeOf(typeof(SIX)); startup.si.flags = 0x100;
                    startup.si.stdin = read; startup.si.stdout = output; startup.si.stderr = error;
                    startup.attributes = list;
                    // Node/OpenSSL cannot initialize its CSPRNG on Windows without
                    // SystemRoot. Query the OS, never inherit app/user environment.
                    StringBuilder windows = new StringBuilder(32768);
                    uint windowsLength = GetWindowsDirectory(windows, (uint)windows.Capacity);
                    Check(windowsLength > 0 && windowsLength < windows.Capacity);
                    environment = Marshal.StringToHGlobalUni("SystemRoot=" + windows.ToString() + "\0");
                    StringBuilder command = new StringBuilder(Quote(executable));
                    foreach (string arg in args) command.Append(" ").Append(Quote(arg));
                    Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                        0x4 | 0x400 | 0x80000, environment, cwd, ref startup, out child));
                    // No user instruction runs before ownership is established.
                    Check(AssignProcessToJobObject(job, child.process));
                    assigned = true;
                    using (ManualResetEvent stop = new ManualResetEvent(false)) {
                        Thread watchdog = new Thread(delegate() {
                            try { Console.In.ReadLine(); } catch { }
                            // EOF on app death takes exactly the same cleanup path.
                            try { stop.Set(); } catch (ObjectDisposedException) { }
                        });
                        watchdog.IsBackground = true; watchdog.Start();
                        Check(ResumeThread(child.thread) != 0xffffffff);
                        started = true;
                        CloseHandle(read); read = IntPtr.Zero;
                        IntPtr inputHandle = write;
                        byte[] bytes = Convert.FromBase64String(stdinBase64);
                        Thread input = new Thread(delegate() {
                            try {
                                int offset = 0;
                                while (offset < bytes.Length) {
                                    int length = Math.Min(bytes.Length - offset, 65536);
                                    byte[] chunk = new byte[length]; Array.Copy(bytes, offset, chunk, 0, length);
                                    uint written;
                                    if (!WriteFile(inputHandle, chunk, (uint)length, out written, IntPtr.Zero) || written == 0) break;
                                    offset += (int)written;
                                }
                            } finally { CloseHandle(inputHandle); }
                        });
                        input.IsBackground = true; input.Start(); write = IntPtr.Zero;
                        // Only the skill tree now holds the raw output handles.
                        CloseHandle(output); CloseHandle(error);
                        messages.WriteLine("{\"kind\":\"ready\"}");
                        bool exitReported = false;
                        while (!stop.WaitOne(10)) {
                            uint wait = WaitForSingleObject(child.process, 0);
                            Check(wait != 0xffffffff);
                            if (!exitReported && wait == 0) {
                                uint code; Check(GetExitCodeProcess(child.process, out code));
                                messages.WriteLine("{\"kind\":\"exit\",\"exitCode\":" + code.ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"signal\":null}");
                                exitReported = true;
                                // Root completion never releases descendants from
                                // ownership: terminate and verify the whole job.
                                break;
                            }
                        }
                        Check(TerminateJobObject(job, 1));
                        // Query the entire job, not just the root process handle.
                        System.Diagnostics.Stopwatch drain = System.Diagnostics.Stopwatch.StartNew();
                        while (!Empty(job) && drain.ElapsedMilliseconds < 600) Thread.Sleep(5);
                        if (Empty(job)) messages.WriteLine("{\"kind\":\"drained\"}");
                    }
                } catch {
                    try { messages.WriteLine("{\"kind\":\"error\"}"); } catch { }
                } finally {
                    // Assignment failure must kill the still-suspended process too.
                    bool unassignedGone = true;
                    if (child.process != IntPtr.Zero && (!assigned || !started)) {
                        TerminateProcess(child.process, 1);
                        unassignedGone = WaitForSingleObject(child.process, 500) == 0;
                    }
                    if (job != IntPtr.Zero) {
                        TerminateJobObject(job, 1);
                        try {
                            System.Diagnostics.Stopwatch drain = System.Diagnostics.Stopwatch.StartNew();
                            while (!Empty(job) && drain.ElapsedMilliseconds < 600) Thread.Sleep(5);
                            if (unassignedGone && Empty(job)) messages.WriteLine("{\"kind\":\"drained\"}");
                        } catch { }
                        CloseHandle(job);
                    }
                    if (guard != IntPtr.Zero) { TerminateJobObject(guard, 1); CloseHandle(guard); }
                    if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
                    if (child.process != IntPtr.Zero) CloseHandle(child.process);
                    if (read != IntPtr.Zero) CloseHandle(read);
                    if (write != IntPtr.Zero) CloseHandle(write);
                    if (listReady) DeleteProcThreadAttributeList(list);
                    if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
                    if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                    if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                    if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                }
            }
        }
    }
}
'@
try {
    $config = [Console]::In.ReadLine() | ConvertFrom-Json
    [JarelaSkillJob]::Run(
        [string]$config.executable, [string[]]$config.args, [string]$config.cwd,
        [string]$config.stdinBase64, [string]$config.pipe)
} catch {
    # Never emit input, executable arguments, environment or compiler diagnostics.
    exit 1
}
