# Starts a Windows child in a kill-on-close Job Object.
# Dot-source this file, then keep the returned object alive until cleanup:
#   $child = Start-ManagedChildProcess -FilePath $exe -Arguments $args -WorkingDirectory $dir
#   try { $child.Process.WaitForExit() } finally { $child.Dispose() }

function Start-ManagedChildProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$FilePath,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Arguments,
    [Parameter(Mandatory=$true)][ValidateNotNullOrEmpty()][string]$WorkingDirectory
  )

  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Managed child processes require Windows.'
  }

  $resolvedWorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
  if (-not [IO.Directory]::Exists($resolvedWorkingDirectory)) {
    throw 'Managed child working directory does not exist.'
  }

  $resolvedFilePath = $FilePath
  if (-not [IO.Path]::IsPathRooted($resolvedFilePath) -and
      $resolvedFilePath.IndexOfAny([char[]]@('\','/')) -ge 0) {
    $resolvedFilePath = [IO.Path]::GetFullPath((Join-Path $resolvedWorkingDirectory $resolvedFilePath))
  }

  if (-not ('CodexHarmony.ManagedChildLauncher' -as [type])) {
    $source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexHarmony
{
    public sealed class ManagedChildJob : IDisposable
    {
        private IntPtr handle;

        internal ManagedChildJob(IntPtr value) { handle = value; }

        public void Dispose()
        {
            IntPtr value;
            lock (this) { value = handle; handle = IntPtr.Zero; }
            if (value != IntPtr.Zero) NativeMethods.CloseHandle(value);
            GC.SuppressFinalize(this);
        }

        ~ManagedChildJob() { Dispose(); }
    }

    public sealed class ManagedChildProcess : IDisposable
    {
        public Process Process { get; private set; }
        public ManagedChildJob Job { get; private set; }
        private bool disposed;

        internal ManagedChildProcess(Process process, ManagedChildJob job)
        {
            Process = process;
            Job = job;
        }

        public void Dispose()
        {
            Process process;
            ManagedChildJob job;
            lock (this)
            {
                if (disposed) return;
                disposed = true;
                process = Process;
                job = Job;
                Process = null;
                Job = null;
            }
            if (job != null) job.Dispose();
            if (process != null) process.Dispose();
            GC.SuppressFinalize(this);
        }

        ~ManagedChildProcess() { Dispose(); }
    }

    internal static class NativeMethods
    {
        internal const uint CreateSuspended = 0x00000004;
        internal const uint ExtendedStartupInfoPresent = 0x00080000;
        internal const uint CreateNoWindow = 0x08000000;
        internal const uint JobObjectExtendedLimitInformation = 9;
        internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
        // ProcThreadAttributeValue(13, false, true, false).
        internal static readonly IntPtr ProcThreadAttributeJobList = new IntPtr(0x0002000D);
        internal const uint WaitObject0 = 0;
        internal const uint Infinite = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfo
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(IntPtr hJob, uint jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int attributeCount, uint flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcessWithJob(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }

    public static class ManagedChildLauncher
    {
        public static string QuoteArgument(string value)
        {
            if (value == null) throw new ArgumentNullException("value");
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int slashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char ch = value[i];
                if (ch == '\\') { slashes++; continue; }
                if (ch == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0) { result.Append('\\', slashes); slashes = 0; }
                result.Append(ch);
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static InvalidOperationException Failure(string operation, int error)
        {
            return new InvalidOperationException(operation + " failed (Win32 error " + error.ToString() + ").");
        }

        public static ManagedChildProcess Start(string filePath, string arguments, string workingDirectory)
        {
            if (String.IsNullOrWhiteSpace(filePath)) throw new ArgumentException("Executable path is required.", "filePath");
            if (arguments == null) throw new ArgumentNullException("arguments");
            if (arguments.IndexOf('\0') >= 0 || filePath.IndexOf('\0') >= 0 || workingDirectory.IndexOf('\0') >= 0)
                throw new ArgumentException("Process inputs cannot contain null characters.");
            if (workingDirectory.Length == 0 || !System.IO.Directory.Exists(workingDirectory))
                throw new ArgumentException("Working directory does not exist.", "workingDirectory");

            string commandLine = QuoteArgument(filePath) + (arguments.Length == 0 ? String.Empty : " " + arguments);
            if (commandLine.Length >= 32767) throw new ArgumentException("Process command line is too long.");

            IntPtr job = IntPtr.Zero;
            IntPtr jobInfo = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr jobListValue = IntPtr.Zero;
            NativeMethods.ProcessInformation processInfo = new NativeMethods.ProcessInformation();
            Process process = null;
            ManagedChildJob managedJob = null;
            try
            {
                job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw Failure("CreateJobObject", Marshal.GetLastWin32Error());

                NativeMethods.ExtendedLimitInformation limits = new NativeMethods.ExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = NativeMethods.JobObjectLimitKillOnJobClose;
                int jobInfoSize = Marshal.SizeOf(typeof(NativeMethods.ExtendedLimitInformation));
                jobInfo = Marshal.AllocHGlobal(jobInfoSize);
                Marshal.StructureToPtr(limits, jobInfo, false);
                if (!NativeMethods.SetInformationJobObject(job, NativeMethods.JobObjectExtendedLimitInformation, jobInfo, (uint)jobInfoSize))
                    throw Failure("SetInformationJobObject", Marshal.GetLastWin32Error());

                IntPtr requiredSize = IntPtr.Zero;
                NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref requiredSize);
                int sizeError = Marshal.GetLastWin32Error();
                if (requiredSize == IntPtr.Zero) throw Failure("InitializeProcThreadAttributeList", sizeError);
                attributeList = Marshal.AllocHGlobal(requiredSize);
                if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref requiredSize))
                    throw Failure("InitializeProcThreadAttributeList", Marshal.GetLastWin32Error());

                jobListValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobListValue, job);
                if (!NativeMethods.UpdateProcThreadAttribute(attributeList, 0, NativeMethods.ProcThreadAttributeJobList,
                        jobListValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw Failure("UpdateProcThreadAttribute", Marshal.GetLastWin32Error());

                NativeMethods.StartupInfoEx startup = new NativeMethods.StartupInfoEx();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(NativeMethods.StartupInfoEx));
                startup.lpAttributeList = attributeList;
                StringBuilder mutableCommandLine = new StringBuilder(commandLine);
                if (!NativeMethods.CreateProcessWithJob(filePath, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, false,
                        NativeMethods.CreateSuspended | NativeMethods.ExtendedStartupInfoPresent | NativeMethods.CreateNoWindow, IntPtr.Zero,
                        workingDirectory, ref startup, out processInfo))
                    throw Failure("CreateProcess", Marshal.GetLastWin32Error());

                // Keep a managed process handle before resuming, so even very short-lived children
                // remain queryable for their exit status after ResumeThread.
                process = Process.GetProcessById((int)processInfo.dwProcessId);
                // Process.GetProcessById is lazy; accessing Handle opens and retains the native
                // process handle before ResumeThread releases a short-lived child to run.
                if (process.Handle == IntPtr.Zero) throw new InvalidOperationException("Could not retain the child process handle.");
                uint previousSuspendCount = NativeMethods.ResumeThread(processInfo.hThread);
                if (previousSuspendCount == 0xFFFFFFFF)
                    throw Failure("ResumeThread", Marshal.GetLastWin32Error());
                if (previousSuspendCount != 1)
                    throw new InvalidOperationException("The suspended child could not be resumed (unexpected suspend count).");

                managedJob = new ManagedChildJob(job);
                job = IntPtr.Zero;
                ManagedChildProcess result = new ManagedChildProcess(process, managedJob);
                process = null;
                managedJob = null;
                return result;
            }
            catch
            {
                if (processInfo.hProcess != IntPtr.Zero)
                {
                    NativeMethods.TerminateProcess(processInfo.hProcess, 1);
                    NativeMethods.WaitForSingleObject(processInfo.hProcess, 5000);
                }
                if (managedJob != null) managedJob.Dispose();
                if (process != null) process.Dispose();
                if (job != IntPtr.Zero) NativeMethods.CloseHandle(job);
                throw;
            }
            finally
            {
                if (attributeList != IntPtr.Zero)
                {
                    NativeMethods.DeleteProcThreadAttributeList(attributeList);
                    Marshal.FreeHGlobal(attributeList);
                }
                if (jobListValue != IntPtr.Zero) Marshal.FreeHGlobal(jobListValue);
                if (jobInfo != IntPtr.Zero) Marshal.FreeHGlobal(jobInfo);
                if (processInfo.hThread != IntPtr.Zero) NativeMethods.CloseHandle(processInfo.hThread);
                if (processInfo.hProcess != IntPtr.Zero) NativeMethods.CloseHandle(processInfo.hProcess);
            }
        }
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  }

  return [CodexHarmony.ManagedChildLauncher]::Start($resolvedFilePath, $Arguments, $resolvedWorkingDirectory)
}
