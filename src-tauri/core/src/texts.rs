//! Reflection texts for "Type to unlock": instead of random characters, you
//! type something that makes you think about why you want to stop early.
//! Plain ASCII and single spaces, so they're fair to type exactly.

/// Details filled into the texts.
pub struct Context<'a> {
    /// Name of the blocked list, e.g. "Social Media".
    pub list: &'a str,
    /// Minutes until the block ends by itself.
    pub minutes_left: i64,
    /// Local time it ends, e.g. "17:30".
    pub until: &'a str,
}

const TEXTS: &[&str] = &[
    "I am about to unlock {list} with {minutes} minutes left. Nothing in there is urgent. It will all still be there at {until}, and so will the reasons I blocked it.",
    "Past me decided to block {list} until {until}. Past me knew this moment would come and planned for it. I am choosing to ignore that plan for a few minutes of scrolling.",
    "In the next {minutes} minutes I could finish one real task, go for a walk, drink water or simply rest. Instead I am typing this so I can open {list}.",
    "This urge feels important, but urges fade in a few minutes if I wait. Typing this text takes longer than the urge would last. I could just let it pass.",
    "I am not missing anything. Whatever is happening on {list} right now will be forgotten by tomorrow. What I do with my time today will not be.",
    "Every time I unlock early, I teach myself that my own rules do not count. Every time I wait it out, I get a little stronger. Right now I am choosing which one to practice.",
    "If a friend told me they wanted to break their own promise to themselves after {minutes} minutes of trying, I would tell them to hold on until {until}. I deserve the same advice.",
    "The block ends at {until}. That is {minutes} minutes from now. I am typing a long text to save {minutes} minutes of waiting, for something I chose to stay away from.",
    "What was I doing before I wanted to open {list}? That task is still waiting. If it feels hard, the hard part is exactly where the progress is.",
    "I set this block because I wanted more focus, more time and more calm. Unlocking it now trades all three for a short distraction that will not make me feel better.",
    "Am I bored, tired, anxious or avoiding something? Opening {list} will not fix any of those. A short break, some air or a glass of water might.",
    "In a week I will not remember these {minutes} minutes on {list}. I might remember that I finished what I started, or that I kept a promise to myself.",
    "The people who get things done are not more disciplined by nature. They build walls like this one and then they leave them standing. I can leave this one standing until {until}.",
    "Unlocking {list} now is not a reward. It is the same loop that made me want a blocker in the first place. Stepping out of the loop is the actual reward.",
    "I am spending real effort to get back to something designed to take my attention. That effort could go into something I actually care about.",
    "This is the moment the blocker was made for. Not the easy hours, but exactly this minute when I want to quit. If I wait now, the block did its job.",
    "Here are some things I could do instead: write down my next step, tidy my desk, stretch, call someone, read a page of a book, or just close my eyes for two minutes.",
    "I am typing this slowly on purpose. With every word I can still change my mind, close this window and keep the promise I made until {until}.",
    "Scrolling feels like rest, but it rarely leaves me rested. If I really need a break, I can take one away from the screen and come back clearer.",
    "Future me will either thank me for holding on until {until} or wish I had. I already know which one feels better. I can still choose it.",
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
    let mut order: Vec<usize> = (0..TEXTS.len()).collect();
    let mut st = seed | 1;
    for i in (1..order.len()).rev() {
        order.swap(i, (next(&mut st) % (i as u64 + 1)) as usize);
    }
    let minutes = ctx.minutes_left.max(1).to_string();
    let list = ctx.list.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).collect::<String>();
    let list = if list.trim().is_empty() { "this list".to_string() } else { list.trim().to_string() };
    let mut out = String::new();
    for i in order.into_iter().cycle() {
        let text = TEXTS[i].replace("{list}", &list).replace("{minutes}", &minutes).replace("{until}", ctx.until);
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
        let ctx = Context { list: "Social Media 💬", minutes_left: 42, until: "17:30" };
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
    }
}
