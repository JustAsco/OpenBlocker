//! Reflection texts for "Type to unlock": instead of random characters, you
//! type something that makes you think about why you want to stop early.
//! Plain ASCII and single spaces, so they're fair to type exactly.

/// Details filled into the texts.
pub struct Context<'a> {
    /// UI language code ("de" for German, anything else English).
    pub lang: &'a str,
    /// Name of the blocked list, e.g. "Social Media".
    pub list: &'a str,
    /// Minutes until the block ends by itself.
    pub minutes_left: i64,
    /// Local time it ends, e.g. "17:30".
    pub until: &'a str,
}

// Deliberately uncomfortable: unlocking early should feel like what it is,
// breaking a promise to yourself.
const TEXTS: &[&str] = &[
    "I am giving up. With {minutes} minutes left before {until}, I am breaking the one promise I made to myself today, and I am doing it for {list}. Nobody is forcing me. I am choosing this.",
    "This is exactly the weakness I wanted to fix when I set this block. I knew this moment would come, I knew I would be tempted, and I am failing the test anyway.",
    "Every time I do this, I prove that my word means nothing, not even to me. I made a rule, and the first time it got uncomfortable I typed my way around it.",
    "I am about to trade {minutes} minutes of my life for scrolling I will not remember tomorrow. Whatever I was supposed to do instead is still waiting, and now I have less time for it.",
    "I am not unlocking {list} because something important happened. I am unlocking it because I am bored, restless or avoiding work, and I cannot sit with that for {minutes} minutes.",
    "Past me trusted me to hold out until {until}. Past me was wrong to trust me. I am letting myself down for a quick hit of distraction.",
    "The people I admire would not be typing this right now. They would be doing the work. I am typing a whole paragraph just to get back to the thing that keeps me from becoming like them.",
    "I already know how this ends: I open {list}, I lose far more than {minutes} minutes, and afterwards I feel worse than I do now. I am choosing that anyway.",
    "This is not a break. A break would be standing up, drinking water or going outside. This is me running back to the habit I said I wanted to quit.",
    "If someone watched me type this, they would see exactly what I am right now: a person who cannot keep a promise to themselves for {minutes} minutes.",
    "I said I wanted more focus, more time and a better life. Right now my actions say I want {list} more than any of that, and actions are what count.",
    "Each early unlock makes the next one easier. I am not just losing today, I am training myself to give up every single time things get slightly hard.",
    "There is nothing on {list} that cannot wait until {until}. I know that. I am unlocking it anyway, so this is not about need. It is about a lack of discipline.",
    "I will tell myself it was only a few minutes. It never is. I am about to waste time I will later wish I had back, and I am doing it with my eyes open.",
    "Somewhere, the version of me that held on until {until} is getting things done. I am choosing not to be that person today.",
    "The block did its job. It stopped me. The only thing between me and {list} now is my own willpower, and I am about to show how little of it I have.",
    "I am typing all of this instead of simply waiting {minutes} minutes. I would rather do something pointless and tedious than face the work I am avoiding.",
    "Tomorrow I will be annoyed that I did this and wonder why I cannot stick to anything. This moment, right now, is the answer to that question.",
    "My goals do not care about my excuses. Every minute on {list} is a minute I chose distraction over the things I claim matter to me.",
    "I set this lock because I do not trust myself. By unlocking it early, I am proving that I was right not to.",
];

const TEXTS_DE: &[&str] = &[
    "Ich gebe auf. {minutes} Minuten vor {until} breche ich das eine Versprechen, das ich mir heute gegeben habe, und das für {list}. Niemand zwingt mich. Ich entscheide mich dafür.",
    "Genau diese Schwäche wollte ich loswerden, als ich diese Sperre gesetzt habe. Ich wusste, dass dieser Moment kommt, ich wusste, dass ich schwach werde, und ich falle trotzdem durch.",
    "Jedes Mal, wenn ich das tue, beweise ich, dass mein Wort nichts wert ist, nicht einmal mir selbst. Ich habe eine Regel aufgestellt und sie beim ersten unangenehmen Moment umgangen.",
    "Ich tausche gerade {minutes} Minuten meines Lebens gegen Scrollen, an das ich mich morgen nicht erinnern werde. Was ich eigentlich tun sollte, wartet immer noch, nur mit weniger Zeit.",
    "Ich entsperre {list} nicht, weil etwas Wichtiges passiert ist. Ich entsperre es, weil ich gelangweilt, unruhig oder auf der Flucht vor Arbeit bin und keine {minutes} Minuten damit aushalte.",
    "Mein früheres Ich hat mir zugetraut, bis {until} durchzuhalten. Es hat sich in mir getäuscht. Ich lasse mich selbst im Stich, für einen schnellen Schuss Ablenkung.",
    "Die Menschen, die ich bewundere, würden das hier nicht tippen. Sie würden arbeiten. Ich tippe einen ganzen Absatz, nur um zu dem zurückzukehren, was mich davon abhält, wie sie zu werden.",
    "Ich weiß schon, wie das endet: Ich öffne {list}, verliere viel mehr als {minutes} Minuten und fühle mich danach schlechter als jetzt. Ich entscheide mich trotzdem dafür.",
    "Das ist keine Pause. Eine Pause wäre aufstehen, Wasser trinken oder rausgehen. Das hier ist ein Rückfall in die Gewohnheit, die ich eigentlich loswerden wollte.",
    "Wenn mir jemand beim Tippen zusehen würde, sähe er genau, was ich gerade bin: jemand, der ein Versprechen an sich selbst keine {minutes} Minuten lang halten kann.",
    "Ich habe gesagt, ich will mehr Fokus, mehr Zeit und ein besseres Leben. Gerade sagen meine Taten, dass ich {list} mehr will als all das, und es zählen die Taten.",
    "Jedes vorzeitige Entsperren macht das nächste leichter. Ich verliere nicht nur heute, ich trainiere mir an, jedes Mal aufzugeben, sobald es ein bisschen schwer wird.",
    "Nichts auf {list} kann nicht bis {until} warten. Das weiß ich. Ich entsperre es trotzdem, also geht es nicht um Notwendigkeit, sondern um fehlende Disziplin.",
    "Ich werde mir sagen, es waren nur ein paar Minuten. Das sind es nie. Ich verschwende gleich Zeit, die ich später gern zurück hätte, und zwar mit offenen Augen.",
    "Irgendwo erledigt die Version von mir, die bis {until} durchgehalten hat, gerade ihre Aufgaben. Ich entscheide mich heute, nicht diese Person zu sein.",
    "Die Sperre hat ihren Job gemacht. Sie hat mich aufgehalten. Zwischen mir und {list} steht nur noch meine Willenskraft, und ich zeige gleich, wie wenig davon ich habe.",
    "Ich tippe das alles, statt einfach {minutes} Minuten zu warten. Lieber mache ich etwas Sinnloses und Mühsames, als mich der Arbeit zu stellen, vor der ich mich drücke.",
    "Morgen werde ich mich darüber ärgern und mich fragen, warum ich nichts durchhalte. Dieser Moment, genau jetzt, ist die Antwort auf diese Frage.",
    "Meinen Zielen sind meine Ausreden egal. Jede Minute auf {list} ist eine Minute, in der ich Ablenkung den Dingen vorziehe, die mir angeblich wichtig sind.",
    "Ich habe diese Sperre gesetzt, weil ich mir selbst nicht vertraue. Wenn ich sie jetzt vorzeitig aufhebe, beweise ich, dass ich damit recht hatte.",
];

/// Small deterministic generator, so the text depends only on `seed`.
fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

/// A reflection text of at least `min_len` characters (whole texts are
/// added in random order until it's long enough).
pub fn reflection(seed: u64, ctx: &Context, min_len: usize) -> String {
    let texts = if ctx.lang.starts_with("de") { TEXTS_DE } else { TEXTS };
    let mut order: Vec<usize> = (0..texts.len()).collect();
    let mut st = seed | 1;
    for i in (1..order.len()).rev() {
        order.swap(i, (next(&mut st) % (i as u64 + 1)) as usize);
    }
    let minutes = ctx.minutes_left.max(1).to_string();
    // Keep it fair to type: no emoji or symbols from the list name.
    let list = ctx.list.chars().filter(|c| (c.is_alphanumeric() || c.is_ascii_punctuation() || *c == ' ') && !c.is_control()).collect::<String>();
    let list = list.split_whitespace().collect::<Vec<_>>().join(" ");
    let fallback = if ctx.lang.starts_with("de") { "diese Liste" } else { "this list" };
    let list = if list.is_empty() { fallback.to_string() } else { list };
    let mut out = String::new();
    for i in order.into_iter().cycle() {
        let text = texts[i].replace("{list}", &list).replace("{minutes}", &minutes).replace("{until}", ctx.until);
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&text);
        if out.len() >= min_len {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_details_and_reaches_the_length() {
        let ctx = Context { lang: "en", list: "Social Media 💬", minutes_left: 42, until: "17:30" };
        let t = reflection(7, &ctx, 400);
        assert!(t.len() >= 400);
        assert!(t.is_ascii(), "fair to type: {t}");
        assert!(!t.contains('{'));
        assert!(!t.contains("  "));
        // Different seeds pick different texts, the same seed the same text.
        assert_eq!(t, reflection(7, &ctx, 400));
        assert_ne!(reflection(1, &ctx, 100), reflection(2, &ctx, 100));
    }

    #[test]
    fn every_text_is_plain() {
        for t in TEXTS {
            assert!(t.is_ascii() && !t.contains("  ") && t.len() > 100, "{t}");
        }
        assert_eq!(TEXTS.len(), TEXTS_DE.len());
        for t in TEXTS_DE {
            assert!(!t.contains("  ") && t.chars().count() > 100, "{t}");
        }
        let ctx = Context { lang: "de", list: "", minutes_left: 5, until: "18:00" };
        assert!(reflection(3, &ctx, 50).contains("18:00") || reflection(3, &ctx, 50).contains("5 Minuten") || !reflection(3, &ctx, 50).contains('{'));
    }
}
