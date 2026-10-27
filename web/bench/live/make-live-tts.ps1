# Speaks the live-tracking fixture lines with Windows SAPI (SSML: breaks for beats, soft words for
# mumbles, rates for slow and fast reads). Writes <id>.wav into the folder given.
param([string]$Out)
New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
function Say($id, $voice, $rate, $body) {
  $s.SelectVoice($voice)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><prosody rate='$rate'>$body</prosody></speak>"
  $s.SetOutputToWaveFile("$Out\$id.wav"); $s.SpeakSsml($ssml); $s.SetOutputToNull()
}
$D = "Microsoft David Desktop"; $Z = "Microsoft Zira Desktop"
Say "kin" $D "medium" "A little more than kin, and less than kind."
Say "kin-beat" $D "medium" "A little more than kin, <break time='1300ms'/> and less than kind."
Say "flesh-beat" $D "medium" "O, that this too too solid flesh would melt, <break time='1600ms'/> thaw, and resolve itself into a dew!"
Say "seems-beat" $Z "medium" "Seems, madam! <break time='1100ms'/> Nay, it is; I know not seems."
Say "frailty-mumble" $D "medium" "Frailty, <prosody volume='x-soft' rate='fast'>thy name</prosody> is woman!"
Say "obey-fast" $Z "fast" "I shall in all my best obey you, madam."
Say "sun-slow-beat" $D "slow" "Not so, my lord; I am too much <break time='1500ms'/> in the sun."
Say "common-mumble-end" $Z "medium" "Ay, madam, it is <prosody volume='x-soft'>common.</prosody>"
Say "cloak-long" $D "medium" "'Tis not alone my inky cloak, good mother, nor customary suits of solemn black, nor windy suspiration of forced breath."
Say "night-short" $Z "medium" "Would the night were come!"
Say "think-beat" $Z "medium" "Let me not think on't; <break time='1200ms'/> frailty, thy name is woman!"
Say "particular-paraphrase" $D "medium" "If it is, why seems it so peculiar with thee?"
Say "kin-fast" $D "x-fast" "A little more than kin, and less than kind."
Say "dew-beat-noclause" $Z "medium" "Thaw, and resolve itself <break time='1400ms'/> into a dew!"
Say "kin-long-beat" $D "medium" "A little more than kin, <break time='2800ms'/> and less than kind."
Say "seems-long-beat" $Z "medium" "Seems, madam! <break time='3200ms'/> Nay, it is; I know not seems."
Say "sun-long-beat-noclause" $D "medium" "Not so, my lord; I am too much <break time='2700ms'/> in the sun."
Say "know-repeat" $Z "medium" "I know not seems. <break time='1500ms'/> 'Tis not alone my inky cloak, good mother."
Say "flesh-fast" $D "fast" "O, that this too too solid flesh would melt, thaw, and resolve itself into a dew!"
# Takes for the wrong-line check: correct reads with words swapped or paraphrased, the cue read
# aloud first, and flubs (only the cue, the next line, the line after the cue, nonsense).
Say "kin-cue-then-line" $D "medium" "But now, my cousin Hamlet, and my son. <break time='700ms'/> A little more than kin, and less than kind."
Say "sun-paraphrase" $D "medium" "Not so, my lord, I'm too much in the sun."
Say "obey-paraphrase" $Z "medium" "I shall, in all my best, obey you, mother."
Say "common-swap" $Z "medium" "Yes, madam, it is common."
Say "kin-paraphrase" $D "medium" "A bit more than kin, and less than kind."
Say "seems-paraphrase" $Z "medium" "Seems, madam? No, it is. I don't know seems."
Say "obey-cue-then-line" $Z "medium" "I pray thee, stay with us; go not to Wittenberg. <break time='600ms'/> I shall in all my best obey you, madam."
Say "kin-cue-only" $D "medium" "But now, my cousin Hamlet, and my son."
Say "kin-next-line" $D "medium" "Not so, my lord; I am too much in the sun."
Say "common-after-cue" $Z "medium" "If it be, why seems it so particular with thee?"
Say "obey-nonsense" $Z "medium" "Sorry, hang on. Where are we? I lost my place."
Say "sun-nonsense" $D "medium" "Um, okay, give me one second."
Say "obey-wrong-cue" $Z "medium" "Let not thy mother lose her prayers, Hamlet."
Say "seems-cue-only" $Z "medium" "If it be, why seems it so particular with thee?"
"done"
