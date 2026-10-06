using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Windows.Forms;

internal static class CodexMobileRemoteLauncher
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--exit") {
            try {
                using (var signal = System.Threading.EventWaitHandle.OpenExisting("Local\\CodexMobileRemoteTrayExit")) signal.Set();
            } catch (System.Threading.WaitHandleCannotBeOpenedException) { }
            return;
        }
        var gate = new System.Threading.Mutex(false, "Local\\CodexMobileRemoteTray");
        var ownsGate = false;
        try
        {
            try
            {
                ownsGate = gate.WaitOne(0);
            }
            catch (System.Threading.AbandonedMutexException)
            {
                ownsGate = true;
            }
            if (!ownsGate)
            {
                try {
                    using (var signal = System.Threading.EventWaitHandle.OpenExisting("Local\\CodexMobileRemoteTrayShow")) signal.Set();
                } catch (System.Threading.WaitHandleCannotBeOpenedException) { }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UnifiedTrayContext());
        }
        finally
        {
            if (ownsGate)
            {
                gate.ReleaseMutex();
            }
            gate.Dispose();
        }
    }
}
