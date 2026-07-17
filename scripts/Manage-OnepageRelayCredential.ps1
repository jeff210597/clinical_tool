[CmdletBinding(DefaultParameterSetName = 'Configure')]
param(
  [Parameter(ParameterSetName = 'Configure')][switch]$Configure,
  [Parameter(ParameterSetName = 'Remove')][switch]$Remove,
  [Parameter(ParameterSetName = 'Read')][switch]$ReadJson,
  [Parameter(ParameterSetName = 'Stdin')][switch]$ReadStdin
)

$ErrorActionPreference = 'Stop'
$Target = 'ClinicalTool/OnepageRelay'

if (-not ('ClinicalToolCredentialNative' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClinicalToolCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount;
    public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
}

function Get-CredentialRecord {
  $ptr = [IntPtr]::Zero
  if (-not [ClinicalToolCredentialNative]::CredRead($Target, 1, 0, [ref]$ptr)) { return $null }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][ClinicalToolCredentialNative+CREDENTIAL])
    $password = if ($credential.CredentialBlobSize -gt 0) { [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)) } else { '' }
    return [pscustomobject]@{ username = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.UserName); password = $password }
  } finally { if ($ptr -ne [IntPtr]::Zero) { [ClinicalToolCredentialNative]::CredFree($ptr) } }
}

if ($Remove) {
  $deleted = [ClinicalToolCredentialNative]::CredDelete($Target, 1, 0)
  if (-not $deleted -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Unable to remove the Windows Credential Manager entry.' }
  Write-Host 'Onepage relay credential removed from Windows Credential Manager.'
  exit 0
}

if ($ReadJson) {
  $record = Get-CredentialRecord
  if (-not $record -or -not $record.username -or -not $record.password) { Write-Output '{"configured":false}'; exit 0 }
  # stdout is consumed directly by the local relay process; it is never logged or sent to Cloudflare.
  [pscustomobject]@{ configured = $true; username = $record.username; password = $record.password } | ConvertTo-Json -Compress
  exit 0
}

$username = if ($ReadStdin) { [Console]::In.ReadLine() } else { Read-Host 'Onepage account' }
$securePassword = if ($ReadStdin) {
  $rawPassword = [Console]::In.ReadLine()
  ConvertTo-SecureString -String $rawPassword -AsPlainText -Force
} else { Read-Host 'Onepage password' -AsSecureString }
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($securePassword)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringUni($passwordPtr)
  if (-not $username.Trim() -or -not $password) { throw 'Account and password are required.' }
  $blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($password)
  try {
    $credential = New-Object ClinicalToolCredentialNative+CREDENTIAL
    $credential.Type = 1; $credential.TargetName = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Target)
    $credential.UserName = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($username.Trim())
    $credential.CredentialBlob = $blob; $credential.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($password); $credential.Persist = 2
    if (-not [ClinicalToolCredentialNative]::CredWrite([ref]$credential, 0)) { throw 'Unable to write the Windows Credential Manager entry.' }
    Write-Host 'Onepage relay credential saved for this Windows user.'
  } finally { if ($blob -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob) } }
} finally { if ($passwordPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($passwordPtr) } }
