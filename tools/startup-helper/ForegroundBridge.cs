using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class SidekickForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
public static class ForegroundBridge {

 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessWorkingSetSizeEx(IntPtr process, UIntPtr min, UIntPtr max, uint flags);
 [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr process, out MemoryCounters counters, uint size);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int info, ref BasicInfo value, int length, out int returned);
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput value);
 [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr reserved, peb, reserved2, reserved3, pid, parent; }
 [StructLayout(LayoutKind.Sequential)] struct MemoryCounters { public uint size, faults; public UIntPtr peakWs, ws, peakPaged, paged, peakNonpaged, nonpaged, pagefile, peakPagefile; }
 [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size, tick; }
 static bool trimmedSelf;
 static uint lastSelfTrim;
 static void TrimIdleBridge(int root, long rootStart, int idle) {
  uint now=unchecked((uint)Environment.TickCount);
  if(trimmedSelf&&unchecked(now-lastSelfTrim)<60000) return;
  var own=GetCurrentProcess(); MemoryCounters memory;
  if(!GetProcessMemoryInfo(own,out memory,(uint)Marshal.SizeOf(typeof(MemoryCounters)))||memory.ws.ToUInt64()<16UL*1024*1024) return;
  // Only a globally idle request may also reclaim this pipe owner. Background
  // renderer requests must never clear a shared bridge while another window
  // is active. Recheck native input after the target operation as well.
  if(RecentApplicationInput(root,rootStart,idle)) return;
  if(SetProcessWorkingSetSizeEx(own,UIntPtr.Size==8?new UIntPtr(UInt64.MaxValue):new UIntPtr(UInt32.MaxValue),UIntPtr.Size==8?new UIntPtr(UInt64.MaxValue):new UIntPtr(UInt32.MaxValue),0)) {
   trimmedSelf=true; lastSelfTrim=now;
  }
 }
 static long Started(IntPtr handle) { long creation, exit, kernel, user; return GetProcessTimes(handle,out creation,out exit,out kernel,out user) ? creation : 0; }
 static bool RecentApplicationInput(int root, long rootStart, int idle) {
  var input=new LastInput { size=(uint)Marshal.SizeOf(typeof(LastInput)) };
  if(!GetLastInputInfo(ref input)) return true;
  if(unchecked((uint)Environment.TickCount-input.tick)>=idle) return false;
  // Activity in another application must not pin this application's hidden
  // working sets. JS checks our own idle time and protected work separately.
  uint foregroundPid; SidekickForeground.GetWindowThreadProcessId(SidekickForeground.GetForegroundWindow(),out foregroundPid);
  if(foregroundPid==0) return false;
  if(foregroundPid==root) return true;
  var handle=OpenProcess(0x1000,false,(int)foregroundPid);
  if(handle==IntPtr.Zero) return true;
  try { return OwnProcess(handle,root,rootStart); } finally { CloseHandle(handle); }
 }
 static bool OwnProcess(IntPtr candidate, int root, long rootStart) {
  var handles = new System.Collections.Generic.List<IntPtr>(); var seen = new System.Collections.Generic.HashSet<int>();
  IntPtr current = candidate;
  try { for(int depth=0;depth<32;depth++) {
   var info=new BasicInfo(); int returned;
   if(NtQueryInformationProcess(current,0,ref info,Marshal.SizeOf(typeof(BasicInfo)),out returned)!=0) return false;
   int pid=info.pid.ToInt32(); long start=Started(current);
   if(pid==root) return start==rootStart;
   if(!seen.Add(pid)||info.parent.ToInt64()<=0||start==0) return false;
   var parent=OpenProcess(0x1000,false,info.parent.ToInt32()); if(parent==IntPtr.Zero) return false;
   handles.Add(parent); long parentStart=Started(parent);
   if(parentStart==0||parentStart>start) return false; current=parent;
  } return false; } finally { foreach(var handle in handles) CloseHandle(handle); }
 }
 static string Trim(string[] parts) {
  int pid,root,idle; double creation,rootCreation; ulong ceiling; long backgroundWindow=0;
  if((parts.Length!=8&&parts.Length!=9)||!Int32.TryParse(parts[2],out pid)||!Double.TryParse(parts[3],System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out creation)||!UInt64.TryParse(parts[4],out ceiling)||!Int32.TryParse(parts[5],out idle)||!Int32.TryParse(parts[6],out root)||!Double.TryParse(parts[7],System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out rootCreation)||pid<=0||root<=0||idle<15000||ceiling<48UL*1024*1024) return "0";
  if(parts.Length==9&&(!Int64.TryParse(parts[8],out backgroundWindow)||backgroundWindow<=0)) return "0";
  // Validate the root against this pipe owner's parent before accepting a tree.
  using(var self=Process.GetCurrentProcess()) {
   var own=new BasicInfo(); int returned;
   if(NtQueryInformationProcess(self.Handle,0,ref own,Marshal.SizeOf(typeof(BasicInfo)),out returned)!=0||own.parent.ToInt64()!=root) return "0";
  }
  var handle=OpenProcess(0x1000|0x100|0x400|0x10,false,pid); if(handle==IntPtr.Zero) return "0";
  try {
   long expected=DateTime.FromFileTimeUtc(0).AddMilliseconds(creation+11644473600000d).ToFileTimeUtc();
   long expectedRoot=DateTime.FromFileTimeUtc(0).AddMilliseconds(rootCreation+11644473600000d).ToFileTimeUtc();
   // Electron rounds process creation time to milliseconds.
   long rootStart=StartedRoot(root,expectedRoot);
   if(rootStart<=0||Math.Abs(Started(handle)-expected)>=10000||!OwnProcess(handle,root,rootStart)) return "0";
   MemoryCounters before,after; uint size=(uint)Marshal.SizeOf(typeof(MemoryCounters));
   if(!GetProcessMemoryInfo(handle,out before,size)) return "0";
   var timer=Stopwatch.StartNew();
   if(backgroundWindow!=0) {
    var window=new IntPtr(backgroundWindow); uint windowPid;
    var foreground=SidekickForeground.GetForegroundWindow();
    // A renderer's local idle is useful while a different window is active.
    // Recheck the supplied top-level HWND immediately before the native call;
    // owned popup menus/dialogs must protect their parent as well.
    if(!SidekickForeground.IsWindow(window)||SidekickForeground.GetWindowThreadProcessId(window,out windowPid)==0||windowPid!=root||foreground==window||SidekickForeground.GetAncestor(foreground,3)==window) return "0";
   } else if(RecentApplicationInput(root,rootStart,idle)) return "0";
   if(!SetProcessWorkingSetSizeEx(handle,UIntPtr.Size == 8 ? new UIntPtr(UInt64.MaxValue) : new UIntPtr(UInt32.MaxValue),UIntPtr.Size == 8 ? new UIntPtr(UInt64.MaxValue) : new UIntPtr(UInt32.MaxValue),0)) return "0";
   if(backgroundWindow==0) TrimIdleBridge(root,rootStart,idle);
   timer.Stop(); if(!GetProcessMemoryInfo(handle,out after,size)) return "0";
   return before.ws.ToUInt64()+","+after.ws.ToUInt64()+","+timer.Elapsed.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
  } finally { CloseHandle(handle); }
 }
 static long StartedRoot(int root,long expected) {
  var handle=OpenProcess(0x1000,false,root); if(handle==IntPtr.Zero) return -1;
  try { long start=Started(handle); return Math.Abs(start-expected)<10000?start:-1; } finally { CloseHandle(handle); }
 }
 public static int Run() {
  Console.WriteLine("READY"); string line;
  while ((line = Console.ReadLine()) != null) {
   if (line == "Q") return 0;
   var parts = line.Split(':'); int id;
   if (parts.Length < 2 || !Int32.TryParse(parts[1], out id) || id <= 0) continue;
   if (parts[0] == "T") { Console.WriteLine("T:" + id + ":" + Trim(parts)); }
   else if (parts[0] == "G" && parts.Length == 2) Console.WriteLine("G:" + id + ":" + SidekickForeground.GetForegroundWindow().ToInt64());
   else if (parts[0] == "S" && parts.Length == 3) {
    long handle; if (!Int64.TryParse(parts[2], out handle) || handle <= 0) { Console.WriteLine("S:" + id + ":0"); continue; }
    var window = new IntPtr(handle);
    if (SidekickForeground.IsIconic(window)) SidekickForeground.ShowWindow(window, 9);
    SidekickForeground.keybd_event(0x12, 0, 0, UIntPtr.Zero); SidekickForeground.keybd_event(0x12, 0, 2, UIntPtr.Zero);
    bool ok = SidekickForeground.SetForegroundWindow(window);
    if (!ok) {
     uint process; uint foreground = SidekickForeground.GetWindowThreadProcessId(SidekickForeground.GetForegroundWindow(), out process); uint current = SidekickForeground.GetCurrentThreadId();
     bool attached = foreground != 0 && foreground != current && SidekickForeground.AttachThreadInput(foreground, current, true);
     try { SidekickForeground.BringWindowToTop(window); ok = SidekickForeground.SetForegroundWindow(window); }
     finally { if (attached) SidekickForeground.AttachThreadInput(foreground, current, false); }
    }
    Console.WriteLine("S:" + id + (ok ? ":1" : ":0"));
   }
  } return 0;
 }
}
