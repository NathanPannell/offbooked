# Convert a document (.doc, .html, .rtf, .txt) to .docx with Microsoft Word.
# Usage: powershell -NoProfile -File word_convert.ps1 <input> <output.docx>
# Word is the converter a director would most likely use ("Save As .docx").
# Macros are disabled and the file is opened read-only; nothing in it runs.
param([Parameter(Mandatory)] [string] $InputPath, [Parameter(Mandatory)] [string] $OutputPath)
$ErrorActionPreference = 'Stop'
$in = (Resolve-Path $InputPath).Path
$out = [System.IO.Path]::GetFullPath($OutputPath)
$word = New-Object -ComObject Word.Application
try {
    $word.Visible = $false
    $word.DisplayAlerts = 0                 # wdAlertsNone
    $word.AutomationSecurity = 3            # msoAutomationSecurityForceDisable
    # Documents.Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
    $doc = $word.Documents.Open($in, $false, $true, $false)
    try {
        $doc.SaveAs2([ref] $out, [ref] 16)  # wdFormatXMLDocument (.docx)
    } finally {
        $doc.Close([ref] 0)
    }
} finally {
    $word.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
Write-Output "wrote $out"
