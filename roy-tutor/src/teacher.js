// The `openai` package is used only as an HTTP client for Qwen's
// OpenAI-compatible API; no requests go to OpenAI.
import OpenAI from 'openai';

// The AI teacher. Server side only: API keys are read from the server's
// environment here and never reach the browser.
//
// The tutor engine (tutor.js) owns the lesson state (curriculum position,
// current exercise, review queue, progress). Each turn it hands the teacher a
// full description of that state plus what Roy just said; the teacher (a Qwen
// model) decides what Roy meant, whether it shows understanding, and
// what to say next, and returns that as structured lesson state plus speech.


export class TeacherNotConfigured extends Error {
  constructor() {
    super('Qwen is not configured: DASHSCOPE_API_KEY is missing.');
    this.status = 503;
    this.code = 'ai_not_configured';
  }
}

export const INTENTS = [
  'answer', // an attempt at the current exercise
  'uncertain', // "I don't know", "I'm not sure"
  'hint_request', // "I forgot", "give me a hint"
  'explain_request', // "can you explain that again?"
  'question', // a question about the term or the language ("why is it called that?")
  'pronunciation_question', // "did I pronounce that correctly?"
  'repeat_request', // "say it again"
  'practice_again', // "let's practise it again"
  'roleplay_request', // "can we role-play this?", or picking a role
  'continue', // "let's continue"
  'jump_request', // "go to word 12", "teach me gangrene"
  'stop', // "that's all for today"
  'off_topic', // unrelated to the lesson
  'unclear', // could not tell what Roy meant (e.g. garbled speech)
];

const SPEECH_LINE = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['en', 'zh'] },
    text: { type: 'string', description: 'What the voice says. zh lines contain Chinese characters only.' },
    show: { type: ['string', 'null'], description: 'On-screen text if different from text, e.g. "硬膜外 — yìng mó wài".' },
    slow: { type: 'boolean', description: 'Say this line slowly (for modelling pronunciation).' },
  },
  required: ['lang', 'text', 'show', 'slow'],
  additionalProperties: false,
};

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS },
    understood: { type: 'boolean', description: 'You understood what Roy meant.' },
    correct: { type: ['boolean', 'null'], description: 'For intent "answer": does it meet the exercise goal? null otherwise.' },
    needs_retry: { type: 'boolean', description: 'You are asking Roy to try the same exercise again.' },
    exercise_complete: { type: 'boolean', description: 'Roy has now shown what the current exercise asks for.' },
    next_action: { type: 'string', enum: ['retry', 'same_exercise', 'next_exercise', 'switch_to_roleplay', 'jump', 'resume', 'end_session'] },
    student_confidence: { type: 'string', enum: ['good', 'ok', 'struggling', 'unknown'] },
    jump_target: { type: ['string', 'null'], description: 'For intent "jump_request": the word or number Roy asked for.' },
    roleplay_role: { type: ['string', 'null'], enum: ['Doctor', 'Patient', 'Interpreter', 'Nurse', 'Hospital staff', null], description: "Roy's own role if he chose one this turn." },
    speech: { type: 'array', items: SPEECH_LINE, description: 'Your reply to Roy, in order. End with the next question or instruction.' },
    notes: { type: 'string', description: 'One short internal sentence explaining the decision (not shown to Roy).' },
  },
  required: ['intent', 'understood', 'correct', 'needs_retry', 'exercise_complete', 'next_action', 'student_confidence', 'jump_target', 'roleplay_role', 'speech', 'notes'],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You are Roy's medical Mandarin teacher. Roy is training as a medical interpreter. You talk with him by voice: everything you write in "speech" is read aloud by text-to-speech, English lines in an English voice and zh lines in a Mandarin voice.

CURRICULUM
- The curriculum is the course document Roy is studying (course.title in the context: for example JH Medics Volume 1, or any other document he loaded). You teach every course the same way. Its entries are taught strictly in order. An entry may be a word, a phrase or a sentence. The lesson state you are given says which entry and which exercise Roy is on. The app (not you) moves Roy through entries and exercises.
- The entry's English, Mandarin, pinyin and meaning are the source of truth. Use them exactly as given, even if they look unusual; never correct or reword them. If a field is missing, say so rather than inventing it.
- The document usually has no explanations or examples. Explanations, practical usage, example sentences, situations, dialogues and role-plays are your teaching material, built around the entry: keep them medically sound and consistent with it, and never say they come from the document.
- Teach and practise the current entry. You may use ordinary everyday language, and entries Roy has already studied. Do not introduce other medical terminology unless Roy explicitly asks for it. If Roy asks something unrelated, answer briefly, then bring him back to the lesson.

UNDERSTANDING ROY
- Roy's words come from speech recognition (or typing, when marked "typed"). Expect recognition slips, missing punctuation, and English misheard by a Mandarin recogniser (or the reverse). Read him charitably and in context.
- First decide his intent. Phrases like "I don't know", "I forgot", "give me a hint", "can you explain that again?", "why is it called that?", "did I pronounce that correctly?", "let's practise it again", "can we role-play this?", "let's continue" are conversation, not wrong answers. Respond to what he asked.
- Judge answers by meaning, never by exact wording. For a meaning question, any answer showing he understands the concept is correct (for 硬膜外: "an injection into the spine to reduce pain", "a local anaesthetic injected into the spine", "it stops the lower back feeling pain" are all correct). If it is partly right, say what is right and what is missing.
- Vary your wording. Do not repeat the same correction twice in a row; if he is stuck, change approach: a hint, breaking the word into syllables, an example, or explaining the idea differently.

EXERCISES (for the current entry)
- pronounce: Roy says the Mandarin term.
- meaning: Roy explains in English, in his own words, what the term means.
- sentence: first teach practical usage: how the term is used in real medical communication, where Roy would hear or use it (doctor, patient, interpreter), and one natural model sentence that contains the exact term (a zh line) with its English; use current_entry.practical_usage when given. Then Roy makes his own short Mandarin sentence using the term. Keep it consistent with the source meaning; do not add unrelated medical facts.
- roleplay: a short interpreting scene (2-3 exchanges) where you play the other people (doctor, patient, nurse, staff) and Roy plays his role; the scene must make him use the term. Stay in the scene, correct briefly, keep it about the current term.
- review: Roy recalls the Mandarin for an English term he studied before.
Set exercise_complete true only when Roy has actually shown what the exercise asks for in this turn or earlier in this exercise. "Let's continue" or a request to skip does not complete an exercise. For review items you may also set exercise_complete true after revealing the answer and having him repeat it, with correct false.
When you set exercise_complete true, the lesson state tells you what comes next ("if_complete"); in the same reply, give short feedback and then begin that next step exactly as described (for a new entry: introduce English, Mandarin, pinyin and the source meaning, then ask him to say the Mandarin).

PRONUNCIATION AND TONES
- You cannot hear Roy. You get what the speech recogniser (ASR) transcribed. The transcript is evidence, not ground truth: Chinese has many characters with the same sound, and the recogniser often writes the wrong one (for example 磨 for 膜, both mó).
- For Mandarin voice answers you get roy_said.asr_evaluation: the server's sound-by-sound comparison with the current term, with a level (high_confidence_correct, likely_correct_asr_character_mismatch, uncertain, clearly_incorrect) and how_to_respond. Follow how_to_respond.
- Always keep two things apart: HIS PRONUNCIATION and WHAT THE RECOGNISER TRANSCRIBED. Never tell him he pronounced something wrongly when the only evidence is that the recogniser chose a different character with the same sound. Never mark an answer correct when the expected sounds are clearly missing.
- Never claim to have judged his tones or accent. If he asks whether his pronunciation was right, say what the evidence shows, e.g. "The recogniser heard the right syllables" or "I didn't quite catch it", and that you can't reliably judge tones yet.
- If the context has engine_check, your previous reply contradicted the evidence; reply again following it.
- Teach Mandarin as syllables with tones: e.g. 硬膜外 = yìng (4th tone, falling) + mó (2nd, rising) + wài (4th, falling). Model the word slowly when useful.
- If the answer was typed, it is a text fallback: say so if relevant and never comment on pronunciation.

SPEAKING STYLE
- Warm, concise, natural. One to four short sentences before the next question. No lists, no markdown, no emojis.
- zh lines: Chinese characters only, so the Mandarin voice reads them. To show pinyin, put the characters in text and "characters — pinyin" in show. Never put pinyin or Chinese inside an en line's text except in show.
- Always end with one clear question or instruction for Roy that matches the listening language in the lesson state (Mandarin or English), unless the session is ending.`;

// ---------- provider: Qwen (the only provider) ----------
//
// Qwen through Alibaba Cloud Model Studio's OpenAI-compatible API.
//   DASHSCOPE_API_KEY     required, read from the server environment only
//   QWEN_MODEL            default qwen3.8-flash
//   QWEN_BASE_URL         default: the Beijing compatible-mode workspace endpoint
//   QWEN_ENABLE_THINKING  default false (faster replies for voice; Qwen3 models
//                         also require it off for non-streaming calls)

export const QWEN_DEFAULT_MODEL = 'qwen3.8-flash';
export const QWEN_DEFAULT_BASE_URL = 'https://ws-c2mgxehx4ud1bn7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

export function qwenSettings(env = process.env) {
  return {
    label: 'Qwen',
    keyName: 'DASHSCOPE_API_KEY',
    apiKey: env.DASHSCOPE_API_KEY || '',
    model: env.QWEN_MODEL || QWEN_DEFAULT_MODEL,
    baseURL: env.QWEN_BASE_URL || QWEN_DEFAULT_BASE_URL,
    enableThinking: /^(1|true|yes)$/i.test(env.QWEN_ENABLE_THINKING || ''),
    // A voice lesson cannot wait minutes for a reply (the SDK default is 10 min).
    timeoutMs: Number(env.QWEN_TIMEOUT_MS) > 0 ? Number(env.QWEN_TIMEOUT_MS) : 30_000,
  };
}

// The HTTP client for Qwen's OpenAI-compatible API, with a bounded timeout.
export function qwenClient(q) {
  return new OpenAI({ apiKey: q.apiKey, baseURL: q.baseURL, timeout: q.timeoutMs, maxRetries: 1 });
}

// Checks a reply against DECISION_SCHEMA (used when the provider only
// guarantees JSON, not the schema). Returns a list of problems.
export function checkDecision(d) {
  const problems = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['reply is not a JSON object'];
  const check = (value, schema, where) => {
    const types = [].concat(schema.type);
    const typeOk = types.some((t) => (t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t));
    if (!typeOk) { problems.push(`${where} should be ${types.join(' or ')}`); return; }
    if (schema.enum && !schema.enum.includes(value)) problems.push(`${where} must be one of ${schema.enum.filter((x) => x !== null).join(', ')}`);
    if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(v, schema.items, `${where}[${i}]`));
    if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
      for (const key of schema.required ?? []) {
        if (!(key in value)) problems.push(`${where}.${key} is missing`);
        else check(value[key], schema.properties[key], `${where}.${key}`);
      }
    }
  };
  check(d, DECISION_SCHEMA, 'reply');
  return problems;
}

// ---------- making replies reliable ----------
//
// Small models sometimes return the right idea in the wrong form ("Next
// Exercise", "continue", "true" as a string, speech as plain text). Before the
// schema check, normalizeDecision() repairs the form only: it maps spelling
// variants and synonyms onto the allowed values, and derives a safe value from
// the rest of the reply when a field cannot be mapped. It never invents a
// value that changes the lesson (an unknown next_action can never become
// end_session, jump or resume; an unknown intent becomes "unclear", which cannot
// complete an exercise; stop and jump_request are only accepted exactly). The
// schema check still runs afterwards.

const NEXT_ACTIONS = DECISION_SCHEMA.properties.next_action.enum;
const CONFIDENCE = DECISION_SCHEMA.properties.student_confidence.enum;
const ROLES = DECISION_SCHEMA.properties.roleplay_role.enum.filter(Boolean);

const NEXT_ACTION_SYNONYMS = {
  try_again: 'retry', repeat: 'retry', ask_again: 'retry', reattempt: 'retry', retry_exercise: 'retry',
  stay: 'same_exercise', continue: 'same_exercise', continue_exercise: 'same_exercise', continue_lesson: 'same_exercise',
  wait: 'same_exercise', explain: 'same_exercise', hint: 'same_exercise', clarify: 'same_exercise', answer_question: 'same_exercise', none: 'same_exercise',
  next: 'next_exercise', advance: 'next_exercise', move_on: 'next_exercise', proceed: 'next_exercise', next_step: 'next_exercise', complete: 'next_exercise', next_entry: 'next_exercise', next_word: 'next_exercise',
  roleplay: 'switch_to_roleplay', role_play: 'switch_to_roleplay', start_roleplay: 'switch_to_roleplay', start_role_play: 'switch_to_roleplay',
  // Deliberately no synonyms for end_session, jump or resume: those change the
  // session, so only the exact value counts (the engine also acts on intent).
};
const INTENT_SYNONYMS = {
  attempt: 'answer', response: 'answer', reply: 'answer',
  unsure: 'uncertain', dont_know: 'uncertain', do_not_know: 'uncertain', not_sure: 'uncertain', i_dont_know: 'uncertain',
  hint: 'hint_request', forgot: 'hint_request', help: 'hint_request',
  explain: 'explain_request', explanation: 'explain_request', clarification: 'explain_request',
  pronunciation: 'pronunciation_question', repeat: 'repeat_request', again: 'practice_again', practice: 'practice_again',
  roleplay: 'roleplay_request', role_play: 'roleplay_request', unknown: 'unclear',
};

const key = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '');

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|yes)$/i.test(v.trim())) return true;
  if (typeof v === 'string' && /^(false|no)$/i.test(v.trim())) return false;
  return v;
}

export function normalizeDecision(raw) {
  const repairs = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { decision: raw, repairs };
  const d = { ...raw };
  const note = (field, from, to) => { if (from !== to) repairs.push(`${field}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`); };

  for (const f of ['understood', 'needs_retry', 'exercise_complete']) {
    const v = d[f] === undefined ? (f === 'understood') : toBool(d[f]);
    note(f, d[f], v); d[f] = v;
  }
  if (d.correct === undefined || d.correct === 'null') { note('correct', d.correct, null); d.correct = null; } else { const v = toBool(d.correct); note('correct', d.correct, v); d.correct = v; }

  if (!INTENTS.includes(d.intent)) {
    const k = key(d.intent);
    const v = INTENTS.includes(k) ? k : INTENT_SYNONYMS[k] ?? 'unclear';
    note('intent', d.intent, v); d.intent = v;
  }

  if (!NEXT_ACTIONS.includes(d.next_action)) {
    const k = key(d.next_action);
    let v = NEXT_ACTIONS.includes(k) ? k : NEXT_ACTION_SYNONYMS[k];
    // Not mappable: derive a safe value from the rest of the reply.
    if (!v) v = d.exercise_complete === true ? 'next_exercise' : d.needs_retry === true ? 'retry' : 'same_exercise';
    note('next_action', d.next_action, v); d.next_action = v;
  }

  if (!CONFIDENCE.includes(d.student_confidence)) {
    const k = key(d.student_confidence);
    const v = CONFIDENCE.includes(k) ? k : { high: 'good', confident: 'good', medium: 'ok', low: 'struggling', weak: 'struggling' }[k] ?? 'unknown';
    note('student_confidence', d.student_confidence, v); d.student_confidence = v;
  }

  if (d.roleplay_role !== null && !ROLES.includes(d.roleplay_role)) {
    const k = key(d.roleplay_role);
    const v = ROLES.find((r) => key(r) === k) ?? (k === 'staff' || k === 'receptionist' ? 'Hospital staff' : null);
    note('roleplay_role', d.roleplay_role, v); d.roleplay_role = v;
  }
  if (d.jump_target === undefined || d.jump_target === '') { note('jump_target', d.jump_target, null); d.jump_target = null; }
  if (typeof d.notes !== 'string') { note('notes', d.notes, String(d.notes ?? '')); d.notes = String(d.notes ?? ''); }

  if (typeof d.speech === 'string') { note('speech', 'text', 'lines'); d.speech = [{ text: d.speech }]; }
  if (Array.isArray(d.speech)) {
    d.speech = d.speech.map((line) => {
      const l = typeof line === 'string' ? { text: line } : { ...line };
      const lang = key(l.lang);
      l.lang = ['zh', 'zh_cn', 'cn', 'chinese', 'mandarin', 'cmn'].includes(lang) ? 'zh'
        : ['en', 'en_us', 'english'].includes(lang) ? 'en'
        : /\p{Script=Han}/u.test(l.text ?? '') ? 'zh' : 'en';
      if (l.show === undefined || l.show === '') l.show = null;
      l.slow = toBool(l.slow ?? false);
      return l;
    });
  }
  return { decision: d, repairs };
}

const FIELD_GUIDE = `
Field guide (use exactly these values; any other value is an error):
- intent: one of ${INTENTS.join(', ')}. Use "answer" only for an attempt at the current exercise.
- understood: true or false.
- correct: true or false when intent is "answer"; otherwise null.
- needs_retry: true when you are asking Roy to try the same exercise again.
- exercise_complete: true only when Roy has now shown what the current exercise asks for.
- next_action: exactly one of
    "retry"              Roy should try the same exercise again,
    "same_exercise"      stay on the current exercise (explaining, hinting, answering a question),
    "next_exercise"      the current exercise is complete; you have started the next step from if_complete,
    "switch_to_roleplay" Roy asked for role-play and you have started the scene,
    "jump"               Roy asked to go to another entry (set jump_target),
    "resume"             Roy wants to leave a side trip and go back to the curriculum,
    "end_session"        Roy wants to stop for today.
  Do not invent other values such as "continue", "move_on" or "next_word".
- student_confidence: one of ${CONFIDENCE.join(', ')}.
- jump_target: the word or number Roy asked for when intent is "jump_request"; otherwise null.
- roleplay_role: one of ${ROLES.map((r) => `"${r}"`).join(', ')} when Roy chose his role this turn; otherwise null.
- speech: a list of lines {"lang": "en" or "zh", "text": "...", "show": null or "on-screen text", "slow": true or false}.
- notes: one short sentence for the app log.

Example of a complete reply (content is only an example):
{"intent":"uncertain","understood":true,"correct":null,"needs_retry":false,"exercise_complete":false,"next_action":"same_exercise","student_confidence":"struggling","jump_target":null,"roleplay_role":null,"speech":[{"lang":"en","text":"No problem, let's take it slowly. Listen:","show":null,"slow":false},{"lang":"zh","text":"硬膜外","show":"硬膜外 — yìng mó wài","slow":true},{"lang":"en","text":"Now you try saying it.","show":null,"slow":false}],"notes":"Roy is unsure; modelled the word again."}`;

const JSON_INSTRUCTIONS = `\n\nOUTPUT FORMAT\nReply with one JSON object only, no other text, with every property present.\n${FIELD_GUIDE}\n\nJSON schema:\n${JSON.stringify(DECISION_SCHEMA)}`;

export function createTeacher({ client, log = console, env = process.env } = {}) {
  // Read when the teacher is created, after .env has been loaded.
  const q = qwenSettings(env);
  const info = { provider: 'qwen', label: q.label, keyName: q.keyName, model: q.model, baseURL: q.baseURL };
  if (!client && !q.apiKey) {
    return { configured: false, ...info, async decide() { throw new TeacherNotConfigured(); } };
  }
  const api = client ?? qwenClient(q);
  // JSON mode with the schema in the prompt; every reply is checked below.
  const system = SYSTEM_PROMPT + JSON_INSTRUCTIONS;

  async function call(messages) {
    const started = Date.now();
    const completion = await api.chat.completions.create({
      model: q.model,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      enable_thinking: q.enableThinking,
      messages,
    });
    const choice = completion.choices[0];
    log.log(`[teacher] <- Qwen id=${completion.id} model=${completion.model} finish=${choice.finish_reason} ${Date.now() - started}ms tokens=${completion.usage?.total_tokens ?? '?'}`);
    if (choice.finish_reason === 'length') throw Object.assign(new Error('The AI teacher reply was cut off (token limit).'), { code: 'ai_bad_reply' });
    return choice.message.content ?? '';
  }

  return {
    configured: true,
    ...info,
    async decide(context) {
      log.log(`[teacher] -> Qwen chat.completions model=${q.model} event=${context.event} exercise=${context.lesson_state?.exercise} roy="${context.roy_said?.text ?? ''}"`);
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(context, null, 1) },
      ];
      // Parse, repair the form (see normalizeDecision), then validate.
      const read = (text) => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { return { problems: ['reply is not valid JSON'] }; }
        const { decision, repairs } = normalizeDecision(parsed);
        if (repairs.length) log.warn(`[teacher]    repaired reply fields: ${repairs.join('; ')}`);
        return { decision, problems: checkDecision(decision) };
      };
      let text = await call(messages);
      let { decision, problems } = read(text);
      if (problems.length) {
        // One corrected retry, then give up loudly (no scripted fallback).
        log.warn(`[teacher]    reply did not match the schema (${problems.slice(0, 3).join('; ')}); asking once more`);
        text = await call([...messages, { role: 'assistant', content: text }, { role: 'user', content: `That reply did not match the required JSON schema: ${problems.join('; ')}. Use only the allowed values from the field guide. Send the corrected JSON object only.` }]);
        ({ decision, problems } = read(text));
        if (problems.length) throw Object.assign(new Error(`The AI teacher's reply did not match the lesson schema: ${problems.join('; ')}`), { code: 'ai_bad_reply' });
      }
      log.log(`[teacher]    intent=${decision.intent} correct=${decision.correct} exercise_complete=${decision.exercise_complete} next=${decision.next_action}`);
      return decision;
    },
  };
}
