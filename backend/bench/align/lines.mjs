// The fixture lines: the script text (what the aligner is given), what the voice says (SSML body,
// with a beat marked by |), the cue before it, and the first words for a restart.
export const LINES = [
  { id: "kin", voice: "D", rate: "medium", text: "A little more than kin, and less than kind.", say: "A little more than kin, | and less than kind.", cue: "But now, my cousin Hamlet, and my son.", frag: "A little more" },
  { id: "seems", voice: "Z", rate: "medium", text: "Seems, madam! Nay, it is; I know not 'seems.'", say: "Seems, madam! | Nay, it is; I know not seems.", cue: "Why seems it so particular with thee?", frag: "Seems, madam" },
  { id: "lived", voice: "Z", rate: "fast", text: "Lived here all my life. Born and raised, never left.", say: "Lived here all my life. | Born and raised, never left.", cue: "So how long have you lived in this town?", frag: "Lived here" },
  { id: "sun", voice: "D", rate: "slow", text: "Not so, my lord; I am too much i' the sun.", say: "Not so, my lord; | I am too much in the sun.", cue: "How is it that the clouds still hang on you?", frag: "Not so, my" },
  { id: "obey", voice: "Z", rate: "fast", text: "I shall in all my best obey you, madam.", say: "I shall in all my best | obey you, madam.", cue: "Stay with us, go not to Wittenberg.", frag: "I shall in" },
  { id: "tobe", voice: "D", rate: "medium", text: "To be, or not to be, that is the question:\nWhether 'tis nobler in the mind to suffer\nThe slings and arrows of outrageous fortune,", say: "To be, or not to be, that is the question: | Whether tis nobler in the mind to suffer the slings and arrows of outrageous fortune,", cue: "Let's withdraw, my lord.", frag: "To be, or not" },
  { id: "night", voice: "Z", rate: "slow", text: "Would the night were come!", say: "Would the night | were come!", cue: "Till then sit still, my soul.", frag: "Would the" },
  { id: "coffee", voice: "D", rate: "fast", text: "I told you already, I don't drink coffee after six.", say: "I told you already, | I don't drink coffee after six.", cue: "Do you want another cup before we go?", frag: "I told you" },
  { id: "seven", voice: "Z", rate: "medium", text: "We leave at 7 tomorrow, so get some sleep. [She turns out the light.]", say: "We leave at seven tomorrow, | so get some sleep.", cue: "What time do we leave?", frag: "We leave at" },
  { id: "frailty", voice: "D", rate: "medium", text: "Frailty, thy name is woman!", say: "Frailty, | thy name is woman!", cue: "Let me not think on it.", frag: "Frailty, thy" },
];
// A long speech for timing (about 45 s).
export const LONG = {
  id: "flesh-speech",
  voice: "D",
  rate: "medium",
  text: "O, that this too too solid flesh would melt\nThaw and resolve itself into a dew!\nOr that the Everlasting had not fix'd\nHis canon 'gainst self-slaughter! O God! God!\nHow weary, stale, flat and unprofitable,\nSeem to me all the uses of this world!\nFie on't! ah fie! 'tis an unweeded garden,\nThat grows to seed; things rank and gross in nature\nPossess it merely. That it should come to this!\nBut two months dead: nay, not so much, not two:\nSo excellent a king; that was, to this,\nHyperion to a satyr; so loving to my mother\nThat he might not beteem the winds of heaven\nVisit her face too roughly.",
  say: "O, that this too too solid flesh would melt, thaw and resolve itself into a dew! Or that the Everlasting had not fixed his canon against self-slaughter! O God! God! | How weary, stale, flat and unprofitable, seem to me all the uses of this world! Fie on it! ah fie! tis an unweeded garden, that grows to seed; things rank and gross in nature possess it merely. | That it should come to this! But two months dead: nay, not so much, not two: so excellent a king; that was, to this, Hyperion to a satyr; so loving to my mother that he might not beteem the winds of heaven visit her face too roughly.",
};
export const VOICES = { D: "Microsoft David Desktop", Z: "Microsoft Zira Desktop" };
