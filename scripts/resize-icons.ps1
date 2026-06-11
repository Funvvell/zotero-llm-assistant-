Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile('C:\Users\27218\.qoderworkcn\workspace\mq862yvausjvxql9\uploads\image_1781108623609_v9p3ase.jpg')
$destDir = 'C:\Users\27218\Documents\zotero-llm-assistant-\addon\icons'

foreach ($size in @(48, 96, 256, 512)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $size, $size)
    $bmp.Save("$destDir\icon@$size.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created icon@$size.png"
}
$src.Dispose()
Write-Host "Done"
