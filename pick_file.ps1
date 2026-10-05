Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select source video'
$dialog.Filter = 'Video files|*.mp4;*.mov;*.mkv;*.avi;*.flv;*.ts;*.m4v;*.webm;*.wmv|All files|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.RestoreDirectory = $true

# TopMost owner form keeps the dialog in front of the browser
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized

$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}

$owner.Dispose()
$dialog.Dispose()
