# Speaks each utterance in specs.json with SAPI, writing <id>.wav and <id>.words.json (each word's
# audio position in ms, from the synthesizer's own SpeakProgress events).
param([string]$Specs, [string]$Out)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$script:words = New-Object System.Collections.ArrayList
$s.add_SpeakProgress({ param($sender, $e) [void]$script:words.Add(@{ ms = [int]$e.AudioPosition.TotalMilliseconds; text = $e.Text; pos = $e.CharacterPosition }) })
foreach ($u in (Get-Content $Specs -Raw | ConvertFrom-Json)) {
  $script:words.Clear()
  $s.SelectVoice($u.voice)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><prosody rate='$($u.rate)' pitch='$($u.pitch)'>$($u.body)</prosody></speak>"
  $s.SetOutputToWaveFile("$Out\$($u.id).wav")
  $s.SpeakSsml($ssml)
  $s.SetOutputToNull()
  ($script:words | ConvertTo-Json -Depth 3) | Set-Content -Encoding utf8 "$Out\$($u.id).words.json"
}
"done"
