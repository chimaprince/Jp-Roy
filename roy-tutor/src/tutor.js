import * as store from './db.js';
import { saidMandarin, saidEnglish, hintFor, normZh } from './match.js';
import { detectIntent, findEntry, ROLES } from './intents.js';

const REVIEW_LIMIT = 10;
const WEAK_LIMIT = 5;
const CONVERSATION_TURNS = 2;

// Collects what the tutor says. Each segment is spoken in its own language;
// `show` is the on-screen text when it differs from what is spoken.
class Reply {
  constructor() {
    this.say = [];
    this.listen = null;
    this.promptStart = null;
  }
  en(text) { this.say.push({ lang: 'en', text }); return this; }
  zh(text, opts = {}) { this.say.push({ lang: 'zh', text, ...opts }); return this; }
  // Everything said after this call is the question that "repeat" will replay.
  prompt() { this.promptStart = this.say.length; return this; }
  ask(lang) { this.listen = lang; return this; }
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

  async message(text) {
    const course = store.activeCourse(this.db);
    if (!course) return this.start();
    const progress = store.getProgress(this.db, this.userId, course.id);
    const session = this.#activeSession(course, progress);
    if (!session || session.state.ended) return this.start();

    const reply = new Reply();
    const intent = detectIntent(text);
    const s = session.state;

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
        if (s.stage === 'review') this.#handleReview(reply, course, session, progress, intent);
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
      session.state.lastPrompt = { say: reply.say.slice(reply.promptStart), listen: reply.listen };
    }
    store.saveSession(this.db, session);
    return { say: reply.say, listen: reply.listen, ...this.#view(course, session), status: this.status() };
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
    reply.ask(last.listen);
  }

  #explain(reply, entry) {
    reply.en(`Let's go over it again. The English term is ${entry.english}.`);
    reply.en('In Mandarin:').zh(entry.mandarin);
    reply.zh(entry.mandarin, { rate: 0.6, show: `Pinyin: ${entry.pinyin}` });
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
    Object.assign(r, { current: id, step: 'ask', misses: 0, forgot: 0 });
    const entry = store.entryById(this.db, id);
    reply.prompt().en(`How do you say "${entry.english}" in Mandarin?`).ask('zh-CN');
  }

  #handleReview(reply, course, session, progress, intent) {
    const r = session.state.review;
    const entry = store.entryById(this.db, r.current);
    if (r.step === 'repeat') {
      if (intent.type === 'answer' && saidMandarin(intent.text, entry)) reply.en('Good.');
      else reply.en('Listen once more.').zh(entry.mandarin, { rate: 0.7 }).en("We'll practise it again soon.");
      this.#nextReview(reply, course, session, progress);
      return;
    }
    if (intent.type === 'forgot') {
      r.forgot += 1;
      if (r.forgot === 1) {
        const { firstChar, firstSyllable } = hintFor(entry);
        reply.en('Here is a hint. It starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
        reply.prompt().en(`Try again: "${entry.english}" in Mandarin?`).ask('zh-CN');
        return;
      }
      this.#reviewMiss(reply, session, entry, true);
      return;
    }
    if (saidMandarin(intent.text, entry)) {
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
      reply.en('Correct!').zh(entry.mandarin, { show: `${entry.mandarin} — ${entry.pinyin}` });
      this.#nextReview(reply, course, session, progress);
      return;
    }
    r.misses += 1;
    if (r.misses === 1) {
      const { firstChar, firstSyllable } = hintFor(entry);
      reply.en('Not quite. It starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
      reply.prompt().en(`Try again: "${entry.english}" in Mandarin?`).ask('zh-CN');
      return;
    }
    this.#reviewMiss(reply, session, entry, false);
  }

  #reviewMiss(reply, session, entry, forgot) {
    const r = session.state.review;
    this.#markWeak(session, entry);
    if (!r.requeued.includes(entry.id)) { r.requeued.push(entry.id); r.queue.push(entry.id); }
    reply.en(forgot ? `The answer is:` : `The correct answer for "${entry.english}" is:`);
    reply.zh(entry.mandarin, { show: `${entry.mandarin} — ${entry.pinyin}` });
    r.step = 'repeat';
    reply.prompt().en('Say it after me.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN');
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
    reply.en('Pinyin:').zh(entry.mandarin, { rate: 0.6, show: entry.pinyin });
    if (entry.meaning) reply.en(`Meaning, from JH Medics: ${entry.meaning}`);
    else reply.en('The JH Medics meaning for this entry has not been loaded yet.');
    reply.prompt().en('Now you say it.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN');
  }

  async #handleLesson(reply, course, session, progress, intent) {
    const l = session.state.lesson;
    const entry = store.entryById(this.db, l.entryId);
    switch (l.step) {
      case 'pronounce': return this.#stepPronounce(reply, l, entry, intent);
      case 'recognize': return this.#stepRecognize(reply, l, entry, intent);
      case 'sentence': return this.#stepSentence(reply, course, session, l, entry, intent);
      case 'conversation': return this.#stepConversation(reply, course, session, l, entry, intent);
    }
  }

  #stepPronounce(reply, l, entry, intent) {
    if (intent.type === 'answer' && saidMandarin(intent.text, entry)) {
      reply.en('Good, I heard it clearly.');
      return this.#askRecognize(reply, l, entry);
    }
    l.attempts += 1;
    if (intent.type === 'answer') l.mistakes += 1;
    if (l.attempts < 3) {
      if (intent.type === 'answer') reply.en(`I heard "${intent.text}". Listen again.`);
      else reply.en('Listen carefully.');
      reply.zh(entry.mandarin, { rate: 0.6, show: `${entry.mandarin} — ${entry.pinyin}` });
      reply.prompt().en('Your turn.').zh(entry.mandarin, { rate: 0.7 }).ask('zh-CN');
      return;
    }
    reply.en("Let's move on. We'll keep practising it.");
    this.#askRecognize(reply, l, entry);
  }

  #askRecognize(reply, l, entry) {
    Object.assign(l, { step: 'recognize', attempts: 0, forgot: 0 });
    reply.prompt().en('Listen.').zh(entry.mandarin).en('What is that in English?').ask('en-US');
  }

  #stepRecognize(reply, l, entry, intent) {
    if (intent.type === 'answer' && saidEnglish(intent.text, entry)) {
      reply.en(`Correct. It's "${entry.english}".`);
      return this.#askSentence(reply, l, entry);
    }
    if (intent.type === 'forgot' && l.forgot === 0) {
      l.forgot += 1;
      reply.en(`Hint: the English starts with "${entry.english.slice(0, 2)}".`);
      reply.prompt().zh(entry.mandarin).en('What is that in English?').ask('en-US');
      return;
    }
    l.attempts += 1;
    l.mistakes += 1;
    if (l.attempts < 2 && intent.type !== 'forgot') {
      reply.en('Not quite.').prompt().en('Try again. What is').zh(entry.mandarin).en('in English?').ask('en-US');
      return;
    }
    reply.zh(entry.mandarin).en(`means "${entry.english}".`);
    this.#askSentence(reply, l, entry);
  }

  #askSentence(reply, l, entry) {
    Object.assign(l, { step: 'sentence', attempts: 0, forgot: 0 });
    reply.prompt().en('Now make a short sentence in Mandarin using').zh(entry.mandarin).ask('zh-CN');
  }

  #exampleSentence(reply, entry) {
    reply.en(`A simple pattern: "This is ${entry.english}" is`).zh(`这是${entry.mandarin}。`);
  }

  async #stepSentence(reply, course, session, l, entry, intent) {
    if (intent.type === 'forgot' || intent.type === 'dontUnderstand') {
      this.#exampleSentence(reply, entry);
      reply.prompt().en('Now try your own sentence with').zh(entry.mandarin).ask('zh-CN');
      return;
    }
    l.attempts += 1;
    let ok = null;
    if (this.ai.enabled) {
      try {
        const result = await this.ai.checkSentence({ entry, known: this.#known(course), sentence: intent.text });
        for (const line of result.feedback) reply.say.push({ lang: line.lang, text: line.text });
        if (!result.correct && result.corrected_sentence) reply.en('A correct version:').zh(result.corrected_sentence);
        ok = result.correct;
      } catch (err) {
        console.error('sentence check failed, using the basic check:', err.message);
      }
    }
    if (ok === null) {
      const used = saidMandarin(intent.text, entry);
      const longer = normZh(intent.text).length > normZh(entry.mandarin).length;
      ok = used && longer;
      if (ok) reply.en('Good, you used').zh(entry.mandarin).en('in a sentence.');
      else if (used) { reply.en('You said the word. Now put it in a full sentence.'); this.#exampleSentence(reply, entry); }
      else { reply.en('Your sentence needs to include').zh(entry.mandarin); }
    }
    if (!ok) l.mistakes += 1;
    if (!ok && l.attempts < 2) {
      reply.prompt().en('Try once more.').ask('zh-CN');
      return;
    }
    await this.#startConversation(reply, course, session);
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
    l.conv = { history: [], turns: 0, scripted: !this.ai.enabled };
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
        reply.ask('zh-CN');
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
    reply.prompt().en(line).ask('zh-CN');
  }

  async #stepConversation(reply, course, session, l, entry, intent) {
    if (intent.type === 'forgot') {
      const { firstChar, firstSyllable } = hintFor(entry);
      reply.en('Hint: the term starts with').zh(firstChar, firstSyllable ? { show: `${firstChar} (${firstSyllable})` } : {});
      this.#repeatPrompt(reply, session);
      return;
    }
    const used = saidMandarin(intent.text, entry);
    l.conv.turns += 1;
    if (!l.conv.scripted) {
      try {
        const result = await this.ai.rolePlay({
          entry, known: this.#known(course), role: 'the other people in the scene',
          roySide: session.state.roySide, history: l.conv.history, royText: intent.text,
        });
        l.conv.history = result.history;
        if (!(result.roy_used_term || used)) l.mistakes += 1;
        const done = result.finished || l.conv.turns >= CONVERSATION_TURNS + 1;
        if (done) {
          for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
          this.#completeEntry(reply, course, session);
        } else {
          reply.prompt();
          for (const line of result.lines) reply.say.push({ lang: line.lang, text: line.text });
          reply.ask('zh-CN');
        }
        return;
      } catch (err) {
        console.error('role-play failed, using the scripted scene:', err.message);
        l.conv.scripted = true;
      }
    }
    if (used) reply.en('Good, you used').zh(entry.mandarin);
    else { l.mistakes += 1; reply.en('Remember to use the term:').zh(entry.mandarin, { show: `${entry.mandarin} — ${entry.pinyin}` }); }
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
