import * as store from './db.js';
import { findEntry } from './intents.js';
import { checkWordRecognition, syllablesWithTones } from './recognition.js';
import { TeacherNotConfigured } from './teacher.js';

// The tutor engine. It owns the lesson state and the rules that must hold no
// matter what the AI says: curriculum order, which exercise comes next, when a
// word counts as complete, daily review, jumps that keep Roy's place, and
// progress in the database. The AI teacher owns the conversation: each turn it
// reads the full lesson context plus what Roy said, decides what he meant and
// whether he showed understanding, and writes the reply.

const REVIEW_LIMIT = 10;
const WEAK_LIMIT = 5;
const TRANSCRIPT_TURNS = 16;

const EXERCISES = ['pronounce', 'meaning', 'sentence', 'roleplay'];
const EXERCISE_GOALS = {
  pronounce: 'Roy says the Mandarin term aloud.',
  meaning: 'Roy explains in English, in his own words, what the term means. Any wording that shows he understands the concept counts.',
  sentence: 'Roy makes a short Mandarin sentence that uses the term.',
  roleplay: 'A short interpreting scene (2-3 exchanges). You play the other people; Roy plays his role and must use the term in Mandarin.',
  review: 'Roy recalls the Mandarin for this English term (he studied it before).',
};
// Which recogniser language the microphone uses for each exercise.
const LISTEN = { pronounce: 'zh-CN', meaning: 'en-US', sentence: 'zh-CN', roleplay: 'zh-CN', review: 'zh-CN' };
const LANGUAGE_NAME = { 'zh-CN': 'Mandarin (zh-CN)', 'en-US': 'English (en-US)' };
// How the answer is checked, for the page's hint line.
const MODE = { pronounce: 'pronunciation', review: 'pronunciation', meaning: 'answer', sentence: 'answer', roleplay: 'answer' };

function localDate(date) {
  return date.toLocaleDateString('en-CA', { timeZone: process.env.TUTOR_TIMEZONE || undefined });
}

function listWords(entries) {
  const names = entries.map((e) => e.english);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function entryFacts(entry, total) {
  return {
    position: entry.position,
    of: total,
    english: entry.english,
    mandarin: entry.mandarin,
    pinyin: entry.pinyin || null,
    pinyin_syllables_with_tones: syllablesWithTones(entry),
    meaning: entry.meaning ?? null,
    source_page: entry.source_page ?? null,
  };
}

export class Tutor {
  constructor({ db, teacher, userId = 'roy', userName = 'Roy', now = () => new Date() }) {
    this.db = db;
    this.teacher = teacher ?? { configured: false };
    this.userId = userId;
    this.userName = userName;
    this.now = now;
    store.ensureUser(db, userId, userName);
  }

  // ---------- public API ----------

  status() {
    const course = store.activeCourse(this.db);
    if (!course) return { course: null, aiConfigured: Boolean(this.teacher.configured) };
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
      aiConfigured: Boolean(this.teacher.configured),
      aiProvider: this.teacher.label ?? null,
      session: session && !session.state.ended ? this.#view(session) : null,
    };
  }

  async start() {
    this.#requireTeacher();
    const course = store.activeCourse(this.db);
    if (!course || store.courseLength(this.db, course.id) === 0) {
      return { say: [{ lang: 'en', text: 'No curriculum is loaded yet. Please import JH Medics Volume 1.' }], listen: null };
    }
    const progress = store.getProgress(this.db, this.userId, course.id);
    const existing = this.#activeSession(course, progress);
    if (existing && !existing.state.ended) {
      return this.#turn(course, existing, { event: 'session_resume', details: 'Roy is back later the same day. Welcome him back briefly and pick up the current exercise where it was.' });
    }

    const today = localDate(this.now());
    const session = store.createSession(this.db, this.userId, course.id, today, this.now().toISOString());
    session.state = { stage: 'lesson', lesson: null, review: null, suspended: null, roySide: 'Interpreter', transcript: [], ended: false };
    const prev = store.previousStudySession(this.db, this.userId, course.id, today);
    const isNewDay = Boolean(progress.last_study_date) && progress.last_study_date < today;
    let reviewRequired = Boolean(progress.review_required) || (isNewDay && Boolean(prev));

    let greeting;
    if (!progress.last_study_date && !prev) {
      greeting = `First ever session. Welcome Roy, say this is ${course.title} and that you will go through it in order, then start the current entry.`;
    } else if (prev) {
      const studied = this.#entries(prev.words_studied.length ? prev.words_studied : prev.words_reviewed);
      const yesterday = prev.study_date === localDate(new Date(this.now().getTime() - 864e5));
      greeting = `Start with: "Welcome back, Roy. ${yesterday ? 'Yesterday' : `Last time (${prev.study_date})`} we studied ${listWords(studied)}." Then continue as the lesson state says.`;
    } else {
      greeting = 'Roy is starting a new session. Welcome him back briefly, then continue as the lesson state says.';
    }

    if (reviewRequired) {
      const queue = this.#buildReviewQueue(course, prev);
      if (queue.length) {
        session.state.stage = 'review';
        session.state.review = { queue: queue.slice(1), current: queue[0], attempts: 0, requeued: [] };
        greeting += ' Review comes first: say you will review before anything new, then ask the first review question.';
      } else {
        reviewRequired = false;
      }
    }
    store.updateProgress(this.db, this.userId, course.id, {
      last_study_date: today,
      last_session: session.id,
      review_required: reviewRequired ? 1 : 0,
    });
    if (!reviewRequired) this.#resumeCurriculum(course, session);
    if (session.state.stage === 'lesson') greeting += ' Introduce the current entry (English, Mandarin, pinyin with tones, the source meaning), then ask Roy to say the Mandarin.';
    return this.#turn(course, session, { event: 'session_start', details: greeting });
  }

  // `meta`: { source: 'voice'|'text', alternatives: string[], confidence: number, language: string }
  async message(text, meta = {}) {
    this.#requireTeacher();
    const course = store.activeCourse(this.db);
    if (!course) return this.start();
    const progress = store.getProgress(this.db, this.userId, course.id);
    const session = this.#activeSession(course, progress);
    if (!session || session.state.ended) return this.start();

    const heard = {
      text: String(text ?? '').trim(),
      alternatives: (meta.alternatives ?? []).map(String).filter((a) => a.trim()).slice(0, 5),
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      source: meta.source === 'voice' ? 'voice' : 'text',
      language: meta.language || this.#listenLanguage(session),
    };
    return this.#turn(course, session, { event: 'student_turn', heard });
  }

  async end(farewell = []) {
    const course = store.activeCourse(this.db);
    const progress = course && store.getProgress(this.db, this.userId, course.id);
    const session = course && this.#activeSession(course, progress);
    if (!session || session.state.ended) {
      return { say: [{ lang: 'en', text: `See you next time, ${this.userName}.` }], listen: null, ended: true, status: this.status() };
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
    const say = farewell.length ? farewell : [{ lang: 'en', text: `Good work today, ${this.userName}.` }];
    return { say: [...say, { lang: 'en', text: `${session.summary} Your place is saved.` }], listen: null, ended: true, status: this.status() };
  }

  // ---------- one turn: context → AI teacher → apply decision ----------

  async #turn(course, session, event) {
    const s = session.state;
    s.transcript ??= [];
    if (event.heard) s.transcript.push({ who: 'roy', text: event.heard.text, input: event.heard.source });

    let decision = await this.teacher.decide(this.#context(course, session, event));
    const followUp = this.#apply(course, session, decision, event);
    if (followUp?.end) {
      s.transcript.push({ who: 'tutor', text: speechText(decision.speech) });
      store.saveSession(this.db, session);
      return this.end(toSegments(decision.speech));
    }
    if (followUp?.event) {
      // The state changed in a way the first reply could not know about (a jump,
      // returning from one): ask the teacher again with the new state.
      decision = await this.teacher.decide(this.#context(course, session, followUp.event));
    }
    s.transcript.push({ who: 'tutor', text: speechText(decision.speech) });
    s.transcript = s.transcript.slice(-TRANSCRIPT_TURNS * 2);
    s.lastDecision = { intent: decision.intent, correct: decision.correct, exercise_complete: decision.exercise_complete, notes: decision.notes };
    store.saveSession(this.db, session);
    const listen = s.stage === 'done' ? null : this.#listenLanguage(session);
    return {
      say: toSegments(decision.speech),
      listen,
      mode: listen ? MODE[this.#exercise(session)] : null,
      ...this.#view(session),
      status: this.status(),
    };
  }

  #apply(course, session, d, event) {
    const s = session.state;
    if (!event.heard) return null; // session start/resume or follow-up: narration only

    if (d.intent === 'stop' || d.next_action === 'end_session') return { end: true };

    if (d.intent === 'jump_request' && d.jump_target) {
      const entry = findEntry(store.allEntries(this.db, course.id), d.jump_target);
      if (!entry) {
        return { event: { event: 'jump_not_found', details: `Roy asked to go to "${d.jump_target}", which is not in ${course.title}. Say so briefly and carry on with the current exercise.` } };
      }
      const progress = store.getProgress(this.db, this.userId, course.id);
      if (s.lesson && !s.lesson.jump && s.lesson.entryId === entry.id) {
        return { event: { event: 'jump_to_current', details: 'Roy asked for the entry he is already on. Say so and continue the current exercise.' } };
      }
      if (!s.lesson?.jump) s.suspended = { stage: s.stage, lesson: s.lesson, review: s.review };
      s.stage = 'lesson';
      s.review = null;
      s.lesson = newLesson(entry.id, true);
      return { event: { event: 'jump_started', details: `Side trip to entry ${entry.position} (${entry.english}) at Roy's request. His curriculum place stays at word ${progress.current_position}; say so. Introduce this entry and ask him to say the Mandarin.` } };
    }

    if ((d.intent === 'continue' || d.next_action === 'resume') && s.lesson?.jump) {
      this.#returnFromJump(course, session);
      return { event: { event: 'returned_from_jump', details: 'Roy ended the side trip. Say you are back on the curriculum and continue the current exercise.' } };
    }

    if (d.roleplay_role) s.roySide = d.roleplay_role;

    const l = s.lesson;
    if (s.stage === 'lesson' && l && (d.intent === 'roleplay_request' || d.next_action === 'switch_to_roleplay') && l.exercise !== 'roleplay') {
      l.exercise = 'roleplay';
      l.attempts = 0;
    }

    if (d.intent === 'answer') {
      if (d.correct === false) {
        if (s.stage === 'review') s.review.attempts += 1;
        else if (l) { l.mistakes += 1; l.attempts += 1; }
      }
    } else if (['uncertain', 'hint_request'].includes(d.intent) && l && s.stage === 'lesson') {
      l.struggles += 1;
    }

    if (!d.exercise_complete) return null;
    if (s.stage === 'review') {
      this.#finishReviewItem(course, session, d.correct === true);
      return null;
    }
    if (s.stage === 'lesson' && l) {
      // Only an actual answer can complete an exercise; "let's continue" cannot skip one.
      if (d.intent !== 'answer' || d.correct === false) {
        console.warn(`ignored exercise_complete for intent=${d.intent} correct=${d.correct}`);
        return null;
      }
      l.passed[l.exercise] = true;
      const next = EXERCISES.find((x) => !l.passed[x]);
      if (next) { l.exercise = next; l.attempts = 0; }
      else this.#completeEntry(course, session);
    }
    return null;
  }

  // Everything the teacher needs for this turn.
  #context(course, session, event) {
    const s = session.state;
    const total = store.courseLength(this.db, course.id);
    const progress = store.getProgress(this.db, this.userId, course.id);
    const entry = this.#currentEntry(session);
    const exercise = this.#exercise(session);
    const ctx = {
      event: event.event,
      event_details: event.details ?? null,
      student: { name: this.userName, roleplay_role: s.roySide },
      course: { title: course.title, total_entries: total, curriculum_position: progress.current_position, completed_entries: store.completedCount(this.db, this.userId, course.id) },
      lesson_state: {
        stage: s.stage,
        exercise,
        exercise_goal: exercise ? EXERCISE_GOALS[exercise] : null,
        exercises_passed: s.lesson ? EXERCISES.filter((x) => s.lesson.passed[x]) : [],
        wrong_attempts_this_exercise: s.stage === 'review' ? s.review?.attempts ?? 0 : s.lesson?.attempts ?? 0,
        side_trip: Boolean(s.lesson?.jump),
        review_items_left_after_this: s.stage === 'review' ? s.review.queue.length : null,
        microphone_language_now: LANGUAGE_NAME[this.#listenLanguage(session)] ?? null,
      },
      current_entry: entry ? entryFacts(entry, total) : null,
      if_complete: this.#previewIfComplete(course, session),
      recent_entries: this.#recentEntries(course, entry),
      weak_words: store.weakEntries(this.db, this.userId, course.id, WEAK_LIMIT).map((e) => ({ english: e.english, mandarin: e.mandarin })),
      conversation_so_far: (s.transcript ?? []).slice(-TRANSCRIPT_TURNS, event.heard ? -1 : undefined),
      roy_said: null,
    };
    if (event.heard) {
      const h = event.heard;
      const mandarinExpected = LISTEN[exercise] === 'zh-CN';
      ctx.roy_said = {
        text: h.text,
        input: h.source === 'voice' ? 'voice (speech recognition transcript)' : 'typed (text fallback, no audio)',
        recogniser_language: h.source === 'voice' ? h.language : null,
        recogniser_alternatives: h.alternatives,
        recogniser_confidence: h.confidence,
        word_recognition: entry && mandarinExpected && h.source === 'voice' ? wordRecognitionReport(entry, h) : null,
        pronunciation_assessment: null,
        pronunciation_assessment_note: 'No audio analysis is available, so tones and accent cannot be judged.',
      };
    }
    return ctx;
  }

  // What happens if the teacher marks the current exercise complete now.
  #previewIfComplete(course, session) {
    const s = session.state;
    const total = store.courseLength(this.db, course.id);
    if (s.stage === 'review' && s.review) {
      if (s.review.queue.length) {
        const next = store.entryById(this.db, s.review.queue[0]);
        return { then: 'next review item', instruction: `Ask Roy how to say "${next.english}" in Mandarin.`, microphone_language: LANGUAGE_NAME['zh-CN'] };
      }
      const progress = store.getProgress(this.db, this.userId, course.id);
      const next = store.entryAt(this.db, course.id, progress.current_position);
      if (!next) return { then: 'course finished', instruction: 'Review is done and every entry has been studied. Congratulate Roy.' };
      return { then: 'review finished, new entry', instruction: 'Say the review is done, then introduce this entry (English, Mandarin, pinyin with tones, source meaning) and ask Roy to say the Mandarin.', next_entry: entryFacts(next, total), microphone_language: LANGUAGE_NAME['zh-CN'] };
    }
    const l = s.lesson;
    if (!l) return null;
    const next = EXERCISES.find((x) => x !== l.exercise && !l.passed[x]);
    if (next) {
      return { then: `exercise "${next}"`, instruction: `Start the ${next} exercise: ${EXERCISE_GOALS[next]}`, microphone_language: LANGUAGE_NAME[LISTEN[next]] };
    }
    if (l.jump) {
      return { then: 'side trip finished', instruction: 'Say this entry is done and that you are going back to the curriculum; the app will then continue where Roy was.' };
    }
    const upcoming = store.entryAt(this.db, course.id, store.entryById(this.db, l.entryId).position + 1);
    if (!upcoming) return { then: 'course finished', instruction: `This was the last entry of ${course.title}. Congratulate Roy.` };
    return { then: 'entry complete, next entry', instruction: 'Tell Roy this word is complete, then introduce the next entry (English, Mandarin, pinyin with tones, source meaning) and ask him to say the Mandarin.', next_entry: entryFacts(upcoming, total), microphone_language: LANGUAGE_NAME['zh-CN'] };
  }

  // ---------- state helpers ----------

  #requireTeacher() {
    if (!this.teacher.configured) throw new TeacherNotConfigured();
  }

  #activeSession(course, progress) {
    if (!progress.last_session) return null;
    const session = store.getSession(this.db, progress.last_session);
    if (!session || session.course_id !== course.id) return null;
    if (session.study_date !== localDate(this.now())) return null;
    // Sessions saved by the old scripted engine have a different shape; start a
    // fresh session instead (progress lives in the progress tables, not here).
    if (!Array.isArray(session.state.transcript)) return null;
    return session;
  }

  #entries(ids) {
    return ids.map((id) => store.entryById(this.db, id)).filter(Boolean);
  }

  #exercise(session) {
    const s = session.state;
    if (s.stage === 'review') return 'review';
    if (s.stage === 'lesson' && s.lesson) return s.lesson.exercise;
    return null;
  }

  #listenLanguage(session) {
    return LISTEN[this.#exercise(session)] ?? null;
  }

  #currentEntry(session) {
    const s = session.state;
    if (s.stage === 'review' && s.review?.current) return store.entryById(this.db, s.review.current);
    if (s.lesson) return store.entryById(this.db, s.lesson.entryId);
    return null;
  }

  #recentEntries(course, entry) {
    if (!entry) return [];
    return this.db.prepare(`
      SELECT c.english, c.mandarin, c.pinyin FROM curriculum c
      JOIN entry_progress ep ON ep.entry_id = c.id AND ep.user_id = ? AND ep.completed = 1
      WHERE c.course_id = ? AND c.position < ? ORDER BY c.position DESC LIMIT 5`).all(this.userId, course.id, entry.position);
  }

  #view(session) {
    const s = session.state;
    const entry = this.#currentEntry(session);
    const exercise = this.#exercise(session);
    let hide = [];
    if (exercise === 'review') hide = ['mandarin', 'pinyin'];
    if (exercise === 'meaning') hide = ['english', 'meaning'];
    const stage = s.stage === 'review' ? 'review' : exercise === 'roleplay' ? 'conversation' : s.stage === 'done' ? 'done' : 'new';
    return {
      stage,
      exercise,
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

  // ---------- curriculum progression ----------

  #resumeCurriculum(course, session) {
    const progress = store.getProgress(this.db, this.userId, course.id);
    const entry = store.entryAt(this.db, course.id, progress.current_position);
    session.state.review = null;
    if (!entry) {
      session.state.stage = 'done';
      session.state.lesson = null;
      return;
    }
    session.state.stage = 'lesson';
    session.state.lesson = newLesson(entry.id, false);
  }

  #buildReviewQueue(course, prev) {
    const ids = [];
    if (prev) ids.push(...(prev.words_studied.length ? prev.words_studied : prev.words_reviewed));
    for (const e of store.weakEntries(this.db, this.userId, course.id, WEAK_LIMIT)) ids.push(e.id);
    return [...new Set(ids)].slice(0, REVIEW_LIMIT);
  }

  #finishReviewItem(course, session, correct) {
    const r = session.state.review;
    const entry = store.entryById(this.db, r.current);
    const ep = store.getEntryProgress(this.db, this.userId, entry.id);
    const firstTry = correct && r.attempts === 0;
    store.updateEntryProgress(this.db, this.userId, entry.id, {
      times_practiced: ep.times_practiced + 1,
      last_reviewed: this.now().toISOString(),
      confidence: correct ? Math.min(5, ep.confidence + (firstTry ? 1 : 0)) : Math.max(0, ep.confidence - 1),
      weak: correct ? (firstTry && ep.confidence + 1 >= 3 ? 0 : ep.weak) : 1,
    });
    if (!session.words_reviewed.includes(entry.id)) session.words_reviewed.push(entry.id);
    if (!correct) {
      if (!session.weak_words.includes(entry.id)) session.weak_words.push(entry.id);
      if (!r.requeued.includes(entry.id)) { r.requeued.push(entry.id); r.queue.push(entry.id); }
    }
    const next = r.queue.shift();
    if (next) {
      Object.assign(r, { current: next, attempts: 0 });
      return;
    }
    store.updateProgress(this.db, this.userId, course.id, { review_required: 0 });
    this.#resumeCurriculum(course, session);
  }

  #completeEntry(course, session) {
    const s = session.state;
    const l = s.lesson;
    const entry = store.entryById(this.db, l.entryId);
    const ep = store.getEntryProgress(this.db, this.userId, entry.id);
    const weak = l.mistakes >= 2 || l.struggles >= 2;
    const nowIso = this.now().toISOString();
    if (weak && !session.weak_words.includes(entry.id)) session.weak_words.push(entry.id);

    if (l.jump) {
      store.updateEntryProgress(this.db, this.userId, entry.id, {
        times_practiced: ep.times_practiced + 1,
        last_reviewed: nowIso,
        weak: weak ? 1 : ep.weak,
      });
      if (!session.words_reviewed.includes(entry.id)) session.words_reviewed.push(entry.id);
      this.#returnFromJump(course, session);
      return;
    }

    store.updateEntryProgress(this.db, this.userId, entry.id, {
      completed: 1,
      times_practiced: ep.times_practiced + 1,
      last_reviewed: nowIso,
      confidence: Math.max(1, 5 - l.mistakes - Math.floor(l.struggles / 2)),
      weak: weak ? 1 : 0,
    });
    if (!session.words_studied.includes(entry.id)) session.words_studied.push(entry.id);
    const progress = store.getProgress(this.db, this.userId, course.id);
    if (progress.current_position === entry.position) {
      store.updateProgress(this.db, this.userId, course.id, { current_position: entry.position + 1 });
    }
    this.#resumeCurriculum(course, session);
  }

  #returnFromJump(course, session) {
    const s = session.state;
    const saved = s.suspended;
    s.suspended = null;
    if (!saved || (!saved.lesson && saved.stage !== 'review')) {
      this.#resumeCurriculum(course, session);
      return;
    }
    Object.assign(s, { stage: saved.stage, lesson: saved.lesson, review: saved.review });
  }
}

function newLesson(entryId, jump) {
  return { entryId, exercise: 'pronounce', passed: {}, attempts: 0, mistakes: 0, struggles: 0, jump };
}

function wordRecognitionReport(entry, heard) {
  const r = checkWordRecognition(entry, heard);
  return {
    what_this_is: 'Whether the speech recogniser wrote down the expected characters. Not a pronunciation or tone score.',
    expected: entry.mandarin,
    recogniser_top_result: r.heard,
    result: {
      correct: 'the top result contains the expected term',
      close: 'the expected term appears only among the alternatives, or as pinyin letters',
      partial: 'some of the expected characters were recognised',
      incorrect: 'the expected characters were not recognised',
    }[r.verdict],
    characters_not_recognised: r.missing,
  };
}

function toSegments(speech) {
  return (speech ?? []).map((line) => ({
    lang: line.lang === 'zh' ? 'zh' : 'en',
    text: line.text,
    ...(line.show ? { show: line.show } : {}),
    ...(line.slow ? { rate: 0.6 } : {}),
  }));
}

function speechText(speech) {
  return (speech ?? []).map((line) => line.show || line.text).join(' ');
}
