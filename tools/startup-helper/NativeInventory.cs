using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class NativeInventory {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(int pid, out int session);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parentPid;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string executable;
    }

    static bool Exited(int pid) {
        IntPtr candidate = OpenProcess(0x100000, false, pid);
        if (candidate == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
        try { return WaitForSingleObject(candidate, 0) == 0; }
        finally { CloseHandle(candidate); }
    }

    public static object[] Read() {
        var records = new List<object>();
        int session = Process.GetCurrentProcess().SessionId;
        string account;
        using (var current = WindowsIdentity.GetCurrent()) { account = current.User.Value; }
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot enumerate application processes");
        try {
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            bool present = Process32First(snapshot, ref entry);
            while (present) {
                if (String.Equals(entry.executable, "SidekickAI.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(entry.executable, "SidekickAI-OpenSource.exe", StringComparison.OrdinalIgnoreCase)) {
                    int candidateSession;
                    if (!ProcessIdToSessionId((int)entry.pid, out candidateSession)) {
                        int error = Marshal.GetLastWin32Error();
                        if (error != 87 || !Exited((int)entry.pid)) throw new Win32Exception(error, "Cannot identify application session");
                    } else if (candidateSession == session) {
                        try {
                            using (var identity = new SidekickApplicationProcess((int)entry.pid, false, true)) {
                                if (!identity.Exited) {
                                    if (!String.Equals(Path.GetFileName(identity.executable), entry.executable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Application snapshot identity changed");
                                    if (identity.session == session && identity.sid == account) records.Add(new {
                                        ProcessId = identity.pid, ParentProcessId = (int)entry.parentPid, ExecutablePath = identity.executable,
                                        CommandLine = identity.commandLine, Started = identity.started, Sid = identity.sid, Session = identity.session
                                    });
                                }
                            }
                        } catch (Win32Exception) { if (!Exited((int)entry.pid)) throw; }
                    }
                }
                present = Process32Next(snapshot, ref entry);
            }
            int enumerationError = Marshal.GetLastWin32Error();
            if (enumerationError != 18) throw new Win32Exception(enumerationError, "Cannot complete application process snapshot");
            return records.ToArray();
        } finally { CloseHandle(snapshot); }
    }
}
