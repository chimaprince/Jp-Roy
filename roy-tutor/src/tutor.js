import * as store from './db.js';
import { saidMandarin, hintFor, normZh } from './match.js';
import { detectIntent, findEntry, ROLES } from './intents.js';
import { checkPronunciation, checkMeaningLocally, syllablesFor } from './pronunciation.js';

const REVIEW_LIMIT = 10;
const WEAK_LIMIT = 5;
const CONVERSATION_TURNS = 2;
const MAX_AI_TURNS = 4;

// How the next spoken answer is evaluated.
const PRONUNCIATION = 'pronunciation'; // say the Mandarin term: checked against the expected characters
const ANSWER = 'answer'; // answer or converse: checked for meaning, wording is free

// On-screen form of the term: characters, plus the source pinyin when there is one.
function withPinyin(entry) {
  return entry.pinyin ? `${entry.mandarin} — ${entry.pinyin}` : entry.mandarin;
}

// The recogniser's guess that contains the term, if any, else its top guess.
function bestCandidate(heard, entry) {
  const all = [heard.text, ...(heard.alternatives ?? [])].filter(Boolean);
  return all.find((c) => saidMandarin(c, entry)) ?? heard.text;
}

// Collects what the tutor says. Each segment is spoken in its own language;
// `show` is the on-screen text when it differs from what is spoken.
class Reply {
  constructor() {
    this.say = [];
    this.listen = null;
    this.mode = null;
    this.promptStart = null;
  }
  en(text) { this.say.push({ lang: 'en', text }); return this; }
  zh(text, opts = {}) { this.say.push({ lang: 'zh', text, ...opts }); return this; }
  // Everything said after this call is the question that "repeat" will replay.
  prompt() { this.promptStart = this.say.length; return this; }
  ask(lang, mode = ANSWER) { this.listen = lang; this.mode = lang ? mode : null; return this; }
}

function localDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: process.env.TUTOR_TIMEZONE || undefined });
}

function listWords(entries) {
  const names = entries.map((e) => e.english);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export class Tutor {
  constructor({ db, ai = { enabled: false }, userId = 'roy', userName = 'Roy', now = () => new Date() }) {
    this.db = db;
    this.ai = ai;
    this.userId = userId;
    this.userName = userName;
    this.now = now;
    store.ensureUser(db, userId, userName);
  }

  // ---------- public API ----------

  status() {
    const course = store.activeCourse(this.db);
    if (!course) return { course: null };
    const progress = store.getProgress(this.db, this.userId, course.id);
    const session = this.#activeSession(course, progress);
    const total = store.courseLength(this.db, course.id);
    return {
      course: { id: course.id, title: course.title },
      user: this.userName,
      position: Math.min(progress.current_position, total),
      total,
      completed: store.completedCount(this.db, this.userId, course.id),
      finished: progress.current_position > total,
      reviewRequired: Boolean(progress.review_required),
      lastStudyDate: progress.last_study_date,
      aiEnabled: Boolean(this.ai.enabled),
      session: session && !session.state.ended ? this.#view(course, session) : null,
    };
  }

  async start() {
    const course = store.activeCourse(this.db);
    if (!course || store.courseLength(this.db, course.id) === 0) {
      return { say: [{ lang: 'en', text: 'No curriculum is loaded yet. Please import JH Medics Volume 1.' }], listen: null };
    }
    const progress = store.getProgress(this.db, this.userId, course.id);
    const existing = this.#activeSession(course, progress);
    const reply = new Reply();
    if (existing && !existing.state.ended) {
      reply.en(`Welcome back, ${this.userName}. Let's pick up where we left off.`);
      this.#repeatPrompt(reply, existing);
      return this.#finish(course, existing, reply);
    }

    const today = localDate(this.now());
    const session = store.createSession(this.db, this.userId, course.id, today, this.now().toISOString());
    session.state = { stage: 'new', lesson: null, review: null, suspended: null, roySide: 'Interpreter', ended: false };
    const prev = store.previousStudySession(this.db, this.userId, course.id, today);
    const isNewDay = Boolean(progress.last_study_date) && progress.last_study_date < today;
    let reviewRequired = Boolean(progress.review_required) || (isNewDay && Boolean(prev));

    if (!progress.last_study_date && !prev) {
      const total = store.courseLength(this.db, course.id);
      reply.en(`Welcome, ${this.userName}. This is ${course.title}. We will work through every word in order, starting at word ${progress.current_position} of ${total}.`);
    } else if (prev) {
      const studied = this.#entries(prev.words_studied.length ? prev.words_studied : prev.words_reviewed);
      const when = prev.study_date === localDate(new Date(this.now().getTime() - 864e5)) ? 'Yesterday' : `Last time, on ${prev.study_date},`;
      reply.en(`Welcome back, ${this.userName}. ${when} we studied ${listWords(studied)}.`);
    } else {
      reply.en(`Welcome back, ${this.userName}.`);
    }

    if (reviewRequired) {
      const queue = this.#buildReviewQueue(course, prev);
      if (queue.length) {
        session.state.stage = 'review';
        session.state.review = { queue, requeued: [], current: null, step: 'ask', misses: 0, forgot: 0 };
        reply.en(`Let's review ${queue.length === 1 ? 'that word' : `those ${queue.length} words`} before anything new.`);
        this.#nextReview(reply, course, session, progress);
      } else {
        reviewRequired = false;
      }
    }
    store.updateProgress(this.db, this.userId, course.id, {
      last_study_date: today,
      last_session: session.id,
      review_required: reviewRequired ? 1 : 0,
    });
    if (!reviewRequired) this.#resumeCurriculum(reply, course, session, store.getProgress(this.db, this.userId, course.id));
    return this.#finish(course, session, reply);
  }

  // `meta` describes where the text came from:
  // { source: 'voice'|'text', alternatives: string[], confidence: number }
  async message(text, meta = {}) {
    const course = store.activeCourse(this.db);
    if (!course) return this.start();
    const progress = store.getProgress(this.db, this.userId, course.id);
    const session = this.#activeSession(course, progress);
    if (!session || session.state.ended) return this.start();

    const reply = new Reply();
    const intent = detectIntent(text);
    const s = session.state;
    intent.heard = {
      text: String(text ?? '').trim(),
      alternatives: (meta.alternatives ?? []).map(String).filter((a) => a.trim()).slice(0, 5),
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      source: meta.source === 'voice' ? 'voice' : 'text',
    };

    switch (intent.type) {
      case 'empty':
        reply.en("I didn't catch that.");
        this.#repeatPrompt(reply, session);
        break;
      case 'end':
        return this.end();
      case 'repeat':
        this.#repeatPrompt(reply, session);
        break;
      case 'continue':
        if (s.lesson?.jump) this.#returnFromJump(reply, course, session);
        else { reply.en("Okay, let's continue."); this.#repeatPrompt(reply, session); }
        break;
      case 'backToCurriculum':
        if (s.lesson?.jump) this.#returnFromJump(reply, course, session);
        else { reply.en("We're already on the curriculum."); this.#repeatPrompt(reply, session); }
        break;
      case 'dontUnderstand': {
        const entry = this.#currentEntry(session);
        if (entry) this.#explain(reply, entry);
        this.#repeatPrompt(reply, session);
        break;
      }
      case 'jump':
        this.#jump(reply, course, session, progress, intent.target);
        break;
      case 'role':
        this.#setRole(reply, course, session, intent);
        if (s.lesson?.step === 'conversation') await this.#startConversation(reply, course, session);
        else this.#repeatPrompt(reply, session);
        break;
      default:
        if (s.stage === 'review') await this.#handleReview(reply, course, session, progress, intent);
        else if (s.lesson) await this.#handleLesson(reply, course, session, progress, intent);
        else if (s.stage === 'done') reply.en(`You have finished ${course.title}. Say "jump to" and a word to practise it again.`);
        else this.#resumeCurriculum(reply, course, session, progress);
    }
    return this.#finish(course, session, reply);
  }

  end() {
    const course = store.activeCourse(this.db);
    const progress = course && store.getProgress(this.db, this.userId, course.id);
    const session = course && this.#activeSession(course, progress);
    const reply = new Reply();
    if (!session || session.state.ended) {
      reply.en(`See you next time, ${this.userName}.`);
      return { say: reply.say, listen: null, ended: true, status: this.status() };
    }
    const studied = this.#entries(session.words_studied);
    const reviewed = this.#entries(session.words_reviewed);
    const weak = this.#entries(session.weak_words);
    const parts = [];
    if (studied.length) parts.push(`New words: ${listWords(studied)}.`);
    if (reviewed.length) parts.push(`Reviewed: ${listWords(reviewed)}.`);
    if (weak.length) parts.push(`Needs more practice: ${listWords(weak)}.`);
    session.summary = parts.join(' ') || 'No words finished this session.';
    session.ended_at = this.now().toISOString();
    session.state.ended = true;
    store.saveSession(this.db, session);
    store.updateProgress(this.db, this.userId, course.id, { last_session: session.id });
    reply.en(`Good work today, ${this.userName}. ${session.summary} Your place is saved.`);
    return { say: reply.say, listen: null, ended: true, status: this.status() };
  }

  // ---------- session helpers ----------

  #activeSession(course, progress) {
    if (!progress.last_session) return null;
    const session = store.getSession(this.db, progress.last_session);
    if (!session || session.course_id !== course.id) return null;
    if (session.study_date !== localDate(this.now())) return null;
    return session;
  }

  #entries(ids) {
    return ids.map((id) => store.entryById(this.db, id)).filter(Boolean);
  }

  #finish(course, session, reply) {
    if (reply.promptStart !== null) {
      session.state.lastPrompt = { say: reply.say.slice(reply.promptStart), listen: reply.listen, mode: reply.mode };
    }
    store.saveSession(this.db, session);
    return { say: reply.say, listen: reply.listen, mode: reply.mode, ...this.#view(course, session), status: this.status() };
  }

  #view(course, session) {
    const s = session.state;
    const entry = this.#currentEntry(session);
    let hide = [];
    if (s.stage === 'review' && s.review?.step === 'ask') hide = ['mandarin', 'pinyin'];
    if (s.lesson?.step === 'recognize') hide = ['english', 'meaning'];
    const stage = s.stage === 'review' ? 'review' : s.lesson?.step === 'conversation' ? 'conversation' : s.stage === 'done' ? 'done' : 'new';
    return {
      stage,
      jump: Boolean(s.lesson?.jump),
      role: s.roySide,
      card: entry
        ? {
            position: entry.position,
            english: hide.includes('english') ? null : entry.english,
            mandarin: hide.includes('mandarin') ? null : entry.mandarin,
            pinyin: hide.includes('pinyin') ? null : entry.pinyin,
            meaning: hide.includes('meaning') ? null : entry.meaning,
            sourcePage: entry.source_page,
          }
        : null,
    };
  }

  #currentEntry(session) {
    const s = session.state;
    if (s.stage === 'review' && s.review?.current) return store.entryById(this.db, s.review.current);
    if (s.lesson) return store.entryById(this.db, s.lesson.entryId);
    return null;
  }

  #repeatPrompt(reply, session) {
    const last = session.state.lastPrompt;
    if (!last) return;
    reply.prompt();
    reply.say.push(...last.say);
    reply.ask(last.listen, last.mode ?? ANSWER);
  }

  #explain(reply, entry) {
    reply.en(`Let's go over it again. The English term is ${entry.english}.`);
    reply.en('In Mandarin:').zh(entry.mandarin);
    reply.zh(entry.mandarin, { rate: 0.6, show: entry.pinyin ? `Pinyin: ${entry.pinyin}` : entry.mandarin });
    if (entry.meaning) reply.en(`The JH Medics meaning is: ${entry.meaning}`);
    else reply.en(`The JH Medics meaning for this entry has not been loaded yet, so I will only use the English term: ${entry.english}.`);
  }

  // ---------- review ----------

  #buildReviewQueue(course, prev) {
    const ids = [];
    if (prev) ids.push(...(prev.words_studied.length ? prev.words_studied : prev.words_reviewed));
    for (const e of store.weakEntries(this.db, this.userId, course.id, WEAK_LIMIT)) ids.push(e.id);
    return [...new Set(ids)].slice(0, REVIEW_LIMIT);
  }

  #nextReview(reply, course, session, progress) {
    const r = session.state.review;
    const id = r.queue.shift();
    if (!id) {
      session.state.review = null;
      session.state.stage = 'new';
      store.updateProgress(this.db, this.userId, course.id, { review_required: 0 });
      reply.en('Review complete. Now, new words.');
      this.#resumeCurriculum(reply, course, session, store.getProgress(this.db, this.userId, course.id));
      return;
    }
    Object.assign(r, { current: id, step: 'ask', misses: 0, forgot: 0, repeats: 0 });
    const entry = store.entryById(this.db, id);
    reply.prompt().en(`How do you say "${entry.english}" in Mandarin?`).ask('zh-CN', PRONUNCIATION);
  }

  async #handleReview(reply, course, session, progress, intent) {
    const r = session.state.review;
    const entry = store.entryById(this.db, r.current);
    if (r.step === 'repeat') {
      if (intent.type === 'forgot' || intent.type === 'dontUnderstand') {
        reply.en('Listen.').zh(entry.mandarin, { rate: 0.6, show: withPinyin(entry) });
        reply.prompt().en('Say it after me.').ask('zh-CN', PRONUNCIATION);
        return;
      }
      const check = checkPronunciation(entry, intent.heard);
      await this.#pronunciationFeedback(reply, session, entry, check, intent.heard);
      r.repeats = (r.repeats ?? 0) + 1;
      if (!check.passed && r.repeats < 3) {
        this.#modelPronunciation(reply, entry, r.repeats + 1);
        reply.prompt().en('Say it after me.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN', PRONUNCIATION);
        return;
      }
      if (!check.passed) reply.en("We'll come back to this one.");
      this.#nextReview(reply, course, session, progress);
      return;
    }
    if (intent.type === 'forgot') {
      r.forgot += 1;
      if (r.forgot === 1) {
        const { firstChar, firstSyllable } = hintFor(entry);
        reply.en('Here is a hint. It starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
        reply.prompt().en(`Try again: "${entry.english}" in Mandarin?`).ask('zh-CN', PRONUNCIATION);
        return;
      }
      this.#reviewMiss(reply, session, entry, true);
      return;
    }
    const check = checkPronunciation(entry, intent.heard);
    if (check.passed) {
      const ep = store.getEntryProgress(this.db, this.userId, entry.id);
      const firstTry = r.misses === 0 && r.forgot === 0;
      const confidence = Math.min(5, ep.confidence + (firstTry ? 1 : 0));
      store.updateEntryProgress(this.db, this.userId, entry.id, {
        times_practiced: ep.times_practiced + 1,
        last_reviewed: this.now().toISOString(),
        confidence,
        weak: firstTry && confidence >= 3 ? 0 : ep.weak,
      });
      if (!session.words_reviewed.includes(entry.id)) session.words_reviewed.push(entry.id);
      await this.#pronunciationFeedback(reply, session, entry, check, intent.heard);
      reply.zh(entry.mandarin, { show: withPinyin(entry) });
      this.#nextReview(reply, course, session, progress);
      return;
    }
    r.misses += 1;
    await this.#pronunciationFeedback(reply, session, entry, check, intent.heard);
    if (r.misses === 1) {
      const { firstChar, firstSyllable } = hintFor(entry);
      reply.en('Not quite. It starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
      reply.prompt().en(`Try again: "${entry.english}" in Mandarin?`).ask('zh-CN', PRONUNCIATION);
      return;
    }
    this.#reviewMiss(reply, session, entry, false);
  }

  #reviewMiss(reply, session, entry, forgot) {
    const r = session.state.review;
    this.#markWeak(session, entry);
    if (!r.requeued.includes(entry.id)) { r.requeued.push(entry.id); r.queue.push(entry.id); }
    reply.en(forgot ? `The answer is:` : `The correct answer for "${entry.english}" is:`);
    reply.zh(entry.mandarin, { show: withPinyin(entry) });
    Object.assign(r, { step: 'repeat', repeats: 0 });
    reply.prompt().en('Say it after me.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN', PRONUNCIATION);
  }

  #markWeak(session, entry) {
    const ep = store.getEntryProgress(this.db, this.userId, entry.id);
    store.updateEntryProgress(this.db, this.userId, entry.id, { weak: 1, confidence: Math.max(0, ep.confidence - 1) });
    if (!session.weak_words.includes(entry.id)) session.weak_words.push(entry.id);
  }

  // ---------- lessons ----------

  #resumeCurriculum(reply, course, session, progress) {
    const entry = store.entryAt(this.db, course.id, progress.current_position);
    if (!entry) {
      session.state.stage = 'done';
      session.state.lesson = null;
      reply.en(`You have completed every word in ${course.title}. Well done! You can still say "jump to" and a word to practise it.`);
      return;
    }
    session.state.stage = 'new';
    this.#startLesson(reply, course, session, entry, false);
  }

  #startLesson(reply, course, session, entry, jump) {
    const total = store.courseLength(this.db, course.id);
    session.state.lesson = { entryId: entry.id, step: 'pronounce', attempts: 0, forgot: 0, mistakes: 0, jump, conv: null };
    reply.en(jump ? `Word ${entry.position} of ${total}, as a side trip.` : `Word ${entry.position} of ${total}.`);
    reply.en(`The English term is: ${entry.english}.`);
    reply.en('In Mandarin:').zh(entry.mandarin);
    if (entry.pinyin) reply.en('Pinyin:').zh(entry.mandarin, { rate: 0.6, show: entry.pinyin });
    else reply.en('The JH Medics source gives no pinyin for this entry.');
    if (entry.meaning) reply.en(`Meaning, from JH Medics: ${entry.meaning}`);
    else reply.en('The JH Medics meaning for this entry has not been loaded yet.');
    this.#askPronounce(reply, entry);
  }

  async #handleLesson(reply, course, session, progress, intent) {
    const l = session.state.lesson;
    const entry = store.entryById(this.db, l.entryId);
    switch (l.step) {
      case 'pronounce': return this.#stepPronounce(reply, session, l, entry, intent);
      case 'recognize': return this.#stepRecognize(reply, course, l, entry, intent);
      case 'sentence': return this.#stepSentence(reply, course, session, l, entry, intent);
      case 'conversation': return this.#stepConversation(reply, course, session, l, entry, intent);
    }
  }

  // MODE 1: pronunciation. Repeats until the recogniser hears the term.
  #askPronounce(reply, entry) {
    reply.prompt().en('Now you say it.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN', PRONUNCIATION);
  }

  async #stepPronounce(reply, session, l, entry, intent) {
    if (intent.type === 'forgot') {
      reply.en('Listen carefully.').zh(entry.mandarin, { rate: 0.6, show: withPinyin(entry) });
      reply.prompt().en('Your turn.').ask('zh-CN', PRONUNCIATION);
      return;
    }
    const check = checkPronunciation(entry, intent.heard);
    await this.#pronunciationFeedback(reply, session, entry, check, intent.heard);
    if (check.passed) return this.#askRecognize(reply, l, entry);
    l.attempts += 1;
    if (l.attempts <= 2) l.mistakes += 1;
    this.#modelPronunciation(reply, entry, l.attempts);
    reply.prompt().en('Try again. Say').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN', PRONUNCIATION);
  }

  // Slows down as Roy keeps trying: whole word, then syllable by syllable.
  #modelPronunciation(reply, entry, attempts) {
    if (attempts < 3) {
      reply.en('Listen again.').zh(entry.mandarin, { rate: 0.6, show: withPinyin(entry) });
      return;
    }
    reply.en("Let's take it one syllable at a time.");
    const syllables = syllablesFor(entry);
    [...normZh(entry.mandarin)].forEach((char, i) => {
      reply.zh(char, { rate: 0.5, show: syllables[i] ? `${char} ${syllables[i]}` : char });
    });
    reply.en('Now the whole term:').zh(entry.mandarin, { rate: 0.6, show: withPinyin(entry) });
  }

  async #pronunciationFeedback(reply, session, entry, check, heard) {
    if (check.typed) {
      if (check.passed) reply.en("That's the right word. Say it out loud when you can, so I can check your pronunciation.");
      else reply.en(`You typed "${check.heard}". The term is`).zh(entry.mandarin, { show: withPinyin(entry) });
      return;
    }
    if (check.verdict === 'correct') {
      reply.en(check.lowConfidence ? 'Correct, but the speech recogniser was not very sure. Say it a little more clearly next time.' : 'Correct! I heard').zh(entry.mandarin);
      return;
    }
    if (!session.state.pronNoteGiven) {
      session.state.pronNoteGiven = true;
      reply.en("A note on how I check: I go by what the speech recogniser writes down. I can tell which syllables it heard, but I can't measure your tones directly.");
    }
    if (check.verdict === 'close') {
      const viaPinyin = check.via && !/\p{Script=Han}/u.test(check.via);
      reply.en(viaPinyin
        ? `Good. I heard the right syllables, "${check.via}", but I can't check the tones from that.`
        : `Close. The recogniser first wrote "${check.heard}", but it also heard the right term. Say it a little more clearly.`);
      return;
    }
    reply.en(check.heard ? `I heard "${check.heard}".` : "I didn't hear any Mandarin.");
    let explained = false;
    if (this.ai.enabled && check.heard) {
      try {
        const result = await this.ai.explainPronunciation({ entry, check, alternatives: heard.alternatives ?? [] });
        for (const line of result.feedback) reply.say.push({ lang: line.lang, text: line.text });
        explained = true;
      } catch (err) {
        console.error('pronunciation feedback failed, using the basic feedback:', err.message);
      }
    }
    if (explained) return;
    if (check.verdict === 'partial') {
      reply.en('Some of it was right. The part to work on:');
      for (const m of check.missing) reply.zh(m.char, { show: m.syllable ? `${m.char} (${m.syllable})` : m.char });
    } else {
      reply.en("That didn't sound like the term yet.");
    }
  }

  // MODE 2: does Roy know what the term means? Any natural answer that shows
  // the meaning is accepted.
  #askRecognize(reply, l, entry) {
    Object.assign(l, { step: 'recognize', attempts: 0, forgot: 0 });
    reply.prompt().en('What does').zh(entry.mandarin).en('mean? Answer in English, in your own words.').ask('en-US', ANSWER);
  }

  async #stepRecognize(reply, course, l, entry, intent) {
    if (intent.type === 'forgot') {
      l.forgot += 1;
      if (l.forgot === 1) {
        reply.en(`Hint: the English starts with "${entry.english.slice(0, 2)}".`);
        reply.prompt().en('What does').zh(entry.mandarin).en('mean?').ask('en-US', ANSWER);
        return;
      }
      this.#revealMeaning(reply, entry);
      return;
    }
    const answer = intent.heard.text;
    let result = null;
    if (this.ai.enabled) {
      try {
        result = await this.ai.checkMeaning({ entry, known: this.#known(course), answer });
        for (const line of result.feedback) reply.say.push({ lang: line.lang, text: line.text });
      } catch (err) {
        console.error('meaning check failed, using the basic check:', err.message);
        result = null;
      }
    }
    if (!result) {
      const local = checkMeaningLocally(entry, answer);
      result = { correct: local.correct };
      if (local.correct) reply.en(`Correct. It means "${entry.english}".`);
      else reply.en(`You said "${answer}". That isn't what`).zh(entry.mandarin).en('means.');
    }
    if (result.correct) return this.#askSentence(reply, l, entry);
    l.attempts += 1;
    if (l.attempts <= 2) l.mistakes += 1;
    if (l.attempts === 1) {
      reply.prompt().en('Try again. What does').zh(entry.mandarin).en('mean?').ask('en-US', ANSWER);
      return;
    }
    this.#revealMeaning(reply, entry);
  }

  #revealMeaning(reply, entry) {
    reply.zh(entry.mandarin).en(`means "${entry.english}".`);
    if (entry.meaning) reply.en(`From JH Medics: ${entry.meaning}`);
    reply.prompt().en('Now tell me in your own words: what does').zh(entry.mandarin).en('mean?').ask('en-US', ANSWER);
  }

  #askSentence(reply, l, entry) {
    Object.assign(l, { step: 'sentence', attempts: 0, forgot: 0 });
    reply.prompt().en('Now make a short sentence in Mandarin using').zh(entry.mandarin).ask('zh-CN', ANSWER);
  }

  #exampleSentence(reply, entry) {
    reply.en(`A simple pattern: "This is ${entry.english}" is`).zh(`这是${entry.mandarin}。`);
  }

  async #stepSentence(reply, course, session, l, entry, intent) {
    if (intent.type === 'forgot' || intent.type === 'dontUnderstand') {
      this.#exampleSentence(reply, entry);
      reply.prompt().en('Now try your own sentence with').zh(entry.mandarin).ask('zh-CN', ANSWER);
      return;
    }
    const sentence = bestCandidate(intent.heard, entry);
    l.attempts += 1;
    let ok = null;
    if (this.ai.enabled) {
      try {
        const result = await this.ai.checkSentence({ entry, known: this.#known(course), sentence });
        for (const line of result.feedback) reply.say.push({ lang: line.lang, text: line.text });
        if (!result.correct && result.corrected_sentence) reply.en('A correct version:').zh(result.corrected_sentence);
        ok = result.correct;
      } catch (err) {
        console.error('sentence check failed, using the basic check:', err.message);
      }
    }
    if (ok === null) {
      const used = saidMandarin(sentence, entry);
      const longer = normZh(sentence).length > normZh(entry.mandarin).length;
      ok = used && longer;
      if (ok) reply.en('Good, you used').zh(entry.mandarin).en('in a sentence.');
      else if (used) reply.en('You said the word. Now put it in a full sentence.');
      else reply.en(`I heard "${sentence}". Your sentence needs to include`).zh(entry.mandarin);
    }
    if (ok) return this.#startConversation(reply, course, session);
    if (l.attempts <= 2) l.mistakes += 1;
    if (l.attempts >= 2) this.#exampleSentence(reply, entry);
    reply.prompt().en('Try once more.').ask('zh-CN', ANSWER);
  }

  #known(course) {
    return store.allEntries(this.db, course.id).filter((e) => {
      const ep = this.db.prepare('SELECT completed FROM entry_progress WHERE user_id = ? AND entry_id = ?').get(this.userId, e.id);
      return ep?.completed;
    });
  }

  // ---------- role-play ----------

  #setRole(reply, course, session, intent) {
    if (!intent.role) {
      reply.en(`You are playing the ${session.state.roySide.toLowerCase()}. You can choose: ${ROLES.join(', ')}.`);
      return;
    }
    session.state.roySide = intent.role;
    reply.en(`Okay, in role-play you are the ${intent.role.toLowerCase()}.`);
    if (session.state.lesson && session.state.lesson.step !== 'conversation') {
      reply.en("We'll use that role in this word's conversation practice.");
    }
  }

  async #startConversation(reply, course, session) {
    const l = session.state.lesson;
    const entry = store.entryById(this.db, l.entryId);
    l.step = 'conversation';
    l.conv = { history: [], turns: 0, used: 0, scripted: !this.ai.enabled };
    reply.en(`Role-play time. You are the ${session.state.roySide.toLowerCase()}.`);
    if (this.ai.enabled) {
      try {
        const result = await this.ai.rolePlay({
          entry, known: this.#known(course), role: 'the other people in the scene',
          roySide: session.state.roySide, history: [], royText: null,
        });
        l.conv.history = result.history;
        reply.prompt();
        for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
        reply.ask('zh-CN', ANSWER);
        return;
      } catch (err) {
        console.error('role-play failed, using the scripted scene:', err.message);
        l.conv.scripted = true;
      }
    }
    this.#scriptedTurn(reply, session, entry);
  }

  #scriptLines(roySide, entry) {
    const term = entry.english;
    const lines = {
      Interpreter: [
        `The doctor says: "We need to discuss the ${term}." Interpret that for the patient in Mandarin.`,
        `The nurse says: "Please tell the patient about the ${term}." Say it to the patient in Mandarin.`,
      ],
      Doctor: [
        `The patient asks, through the interpreter: "Doctor, what is ${term}?" Answer using the Mandarin term.`,
        `The nurse asks: "Should I prepare for the ${term}?" Reply in Mandarin, using the term.`,
      ],
      Patient: [
        `The doctor says: "Today we will talk about ${term}." Tell the doctor, in Mandarin, which term you heard.`,
        `The nurse asks: "Do you have questions about the ${term}?" Ask your question in Mandarin, using the term.`,
      ],
      Nurse: [
        `The doctor says: "Please prepare the patient for the ${term}." Tell the patient in Mandarin.`,
        `The patient asks: "What is happening next?" Answer in Mandarin, using the term.`,
      ],
      'Hospital staff': [
        `A patient at the front desk says they are here about the ${term}. Confirm it in Mandarin.`,
        `The doctor asks you to tell the family about the ${term}. Say it in Mandarin.`,
      ],
    };
    return lines[roySide] ?? lines.Interpreter;
  }

  #scriptedTurn(reply, session, entry) {
    const l = session.state.lesson;
    const line = this.#scriptLines(session.state.roySide, entry)[l.conv.turns];
    reply.prompt().en(line).ask('zh-CN', ANSWER);
  }

  // Each reply must use the term; the scene only moves on when it does.
  async #stepConversation(reply, course, session, l, entry, intent) {
    if (intent.type === 'forgot') {
      const { firstChar, firstSyllable } = hintFor(entry);
      reply.en('Hint: the term starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
      this.#repeatPrompt(reply, session);
      return;
    }
    const royText = bestCandidate(intent.heard, entry);
    const used = saidMandarin(royText, entry);
    if (!l.conv.scripted) {
      try {
        const result = await this.ai.rolePlay({
          entry, known: this.#known(course), role: 'the other people in the scene',
          roySide: session.state.roySide, history: l.conv.history, royText,
        });
        l.conv.history = result.history;
        l.conv.turns += 1;
        if (result.roy_used_term || used) l.conv.used += 1;
        else if (l.conv.turns <= 2) l.mistakes += 1;
        const finished = result.finished || l.conv.turns >= MAX_AI_TURNS;
        if (finished && l.conv.used > 0) {
          for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
          this.#completeEntry(reply, course, session);
          return;
        }
        if (finished) {
          // The scene ended without Roy using the term: one scripted line that needs it.
          for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
          reply.en('Before we finish, you need to use the term in the scene.');
          Object.assign(l.conv, { scripted: true, turns: CONVERSATION_TURNS - 1 });
          this.#scriptedTurn(reply, session, entry);
          return;
        }
        reply.prompt();
        for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
        reply.ask('zh-CN', ANSWER);
        return;
      } catch (err) {
        console.error('role-play failed, using the scripted scene:', err.message);
        l.conv.scripted = true;
      }
    }
    if (!used) {
      l.mistakes += 1;
      reply.en(royText ? `I heard "${royText}". Remember to use the term:` : 'Remember to use the term:');
      reply.zh(entry.mandarin, { show: withPinyin(entry) });
      reply.en('Try that line again.');
      this.#scriptedTurn(reply, session, entry);
      return;
    }
    reply.en('Good, you used').zh(entry.mandarin);
    l.conv.turns += 1;
    if (l.conv.turns < CONVERSATION_TURNS) this.#scriptedTurn(reply, session, entry);
    else this.#completeEntry(reply, course, session);
  }

  // ---------- completion and jumps ----------

  #completeEntry(reply, course, session) {
    const s = session.state;
    const l = s.lesson;
    const entry = store.entryById(this.db, l.entryId);
    const ep = store.getEntryProgress(this.db, this.userId, entry.id);
    const weak = l.mistakes >= 2;
    const nowIso = this.now().toISOString();
    if (weak && !session.weak_words.includes(entry.id)) session.weak_words.push(entry.id);

    if (l.jump) {
      store.updateEntryProgress(this.db, this.userId, entry.id, {
        times_practiced: ep.times_practiced + 1,
        last_reviewed: nowIso,
        weak: weak ? 1 : ep.weak,
      });
      if (!session.words_reviewed.includes(entry.id)) session.words_reviewed.push(entry.id);
      reply.en(`Nice work on ${entry.english}.`);
      this.#returnFromJump(reply, course, session);
      return;
    }

    store.updateEntryProgress(this.db, this.userId, entry.id, {
      completed: 1,
      times_practiced: ep.times_practiced + 1,
      last_reviewed: nowIso,
      confidence: Math.max(1, 5 - l.mistakes),
      weak: weak ? 1 : 0,
    });
    if (!session.words_studied.includes(entry.id)) session.words_studied.push(entry.id);
    const progress = store.getProgress(this.db, this.userId, course.id);
    if (progress.current_position === entry.position) {
      store.updateProgress(this.db, this.userId, course.id, { current_position: entry.position + 1 });
    }
    reply.en(`Word ${entry.position} complete.`);
    this.#resumeCurriculum(reply, course, session, store.getProgress(this.db, this.userId, course.id));
  }

  #jump(reply, course, session, progress, target) {
    const s = session.state;
    const entry = findEntry(store.allEntries(this.db, course.id), target);
    if (!entry) {
      reply.en(`I couldn't find "${target}" in ${course.title}, so we'll stay where we are.`);
      this.#repeatPrompt(reply, session);
      return;
    }
    const onCurrent = s.lesson && !s.lesson.jump && s.lesson.entryId === entry.id;
    if (onCurrent) {
      reply.en("That's the word we're on now. Let's start it again.");
      this.#startLesson(reply, course, session, entry, false);
      return;
    }
    if (!s.lesson?.jump) {
      s.suspended = { stage: s.stage, lesson: s.lesson, review: s.review, lastPrompt: s.lastPrompt };
    }
    s.stage = 'new';
    s.review = null;
    reply.en(`Okay, a quick jump to ${entry.english}. Your place in the curriculum stays at word ${progress.current_position}.`);
    this.#startLesson(reply, course, session, entry, true);
  }

  #returnFromJump(reply, course, session) {
    const s = session.state;
    const saved = s.suspended;
    s.suspended = null;
    if (!saved || (!saved.lesson && saved.stage !== 'review')) {
      reply.en('Back to the curriculum.');
      this.#resumeCurriculum(reply, course, session, store.getProgress(this.db, this.userId, course.id));
      return;
    }
    Object.assign(s, { stage: saved.stage, lesson: saved.lesson, review: saved.review, lastPrompt: saved.lastPrompt });
    const entry = this.#currentEntry(session);
    reply.en(entry && saved.stage !== 'review' ? `Back to the curriculum, word ${entry.position}: ${entry.english}.` : 'Back to the review.');
    this.#repeatPrompt(reply, session);
  }
}
