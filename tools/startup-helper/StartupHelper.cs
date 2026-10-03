using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

public static class StartupHelper {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304, RecursionLimit = 16 };

    static int Integer(Dictionary<string, object> request, string key) {
        object value;
        if (!request.TryGetValue(key, out value) || !(value is int) || (int)value <= 0) throw new InvalidOperationException("Invalid process identity");
        return (int)value;
    }

    static string Text(Dictionary<string, object> request, string key) {
        object value;
        if (!request.TryGetValue(key, out value) || !(value is string)) throw new InvalidOperationException("Invalid request value");
        return (string)value;
    }

    static object Identity(int pid, bool account) {
        SidekickApplicationProcess owner;
        try { owner = new SidekickApplicationProcess(pid, false, account); }
        catch (Win32Exception error) { if (error.NativeErrorCode == 87) return null; throw; }
        using (owner) {
            if (owner.Exited) return null;
            if (account) {
                using (var current = System.Security.Principal.WindowsIdentity.GetCurrent()) {
                    if (owner.sid != current.User.Value || owner.session != System.Diagnostics.Process.GetCurrentProcess().SessionId) throw new InvalidOperationException("Application account or session differs");
                }
            }
            return new { pid = owner.pid, executable = owner.executable, started = owner.started, sid = owner.sid,
                session = owner.session, commandLine = owner.commandLine, elevated = owner.elevated };
        }
    }

    public static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            if (args.Length != 1 || args[0].Length > 24000) throw new InvalidOperationException("Invalid startup request");
            var bytes = Convert.FromBase64String(args[0]);
            if (bytes.Length > 16384) throw new InvalidOperationException("Startup request is too large");
            var request = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes));
            if (request == null) throw new InvalidOperationException("Invalid startup request");
            object result;
            switch (Text(request, "operation")) {
                case "session": {
                    var identity = Identity(Integer(request, "pid"), true);
                    if (identity == null) throw new InvalidOperationException("Application process has exited");
                    result = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(identity))["session"]; break;
                }
                case "inspect": result = Identity(Integer(request, "pid"), true); break;
                case "inspect-image": result = Identity(Integer(request, "pid"), false); break;
                case "inventory": result = NativeInventory.Read(); break;
                case "prepare-session": result = SidekickApplicationProcess.Prepare(Text(request, "endpoint"), Integer(request, "server")); break;
                default: throw new InvalidOperationException("Unsupported startup operation");
            }
            Console.WriteLine(Json.Serialize(result));
            return 0;
        } catch (Exception error) {
            while (error.InnerException != null) error = error.InnerException;
            var native = error as Win32Exception;
            string code = native != null && native.NativeErrorCode == 5 ? "access-denied" : error is TimeoutException ? "timeout"
                : error is IOException ? "unavailable" : "identity-mismatch";
            Console.WriteLine(Json.Serialize(new { error = code, message = error.Message }));
            return 1;
        }
    }
}
