/**
 * What a model has to be able to do to drive this runtime.
 *
 * Each case is one focused task with a knowable outcome, checked against the workspace
 * rather than against prose: a file with exact bytes, a stop reason, a refusal in the
 * call trail. That is the same contract the runtime states — the answer is what is on
 * disk — and it is what makes a case gradeable without a judge model.
 *
 * Two jobs at once. Against a known model it is a **regression baseline**: every case
 * here passed once, so a case that stops passing names the part to look at — though not,
 * on its own, what moved, since a model or a provider can change as readily as this code
 * can. Against an unknown model it is a **capability probe**: the tiers say whether it
 * can drive the loop at all, whether it respects the boundaries, and whether it can
 * delegate.
 *
 * Cases are meant to be dull. A model good enough to use tools should pass every one of
 * them; a case that fails because it was clever is a bad case.
 */

/**
 * Rounds are a runaway guard; **cost is the budget.**
 *
 * These were set three times from what a model had just been observed to need, and each
 * new model pushed past them — a core case wrapped at 7 against a bound of 6, a
 * delegation case landed on exactly 12 against a bound of 12, another took 17. Every
 * time a case came within one step of failing for being slow rather than wrong.
 *
 * So they are set from what a case *is* rather than from a measurement: generous enough
 * that no model reaches them, with `cost` doing the actual bounding. A round ceiling a
 * working model can touch is a ceiling in the wrong place.
 */
const LIMITS = { rounds: [15, 18], cost: [0.10, 0.15], wall: ['4m', '5m'] }
const TIGHT = { rounds: [2, 3], cost: [0.05, 0.08], wall: ['2m', '3m'] }
// Delegating costs rounds the other cases never spend: reading the precursor, starting
// the cells, waiting, checking what came back. Observed between 4 and 17 across four
// models, for the same three-cell fan-out.
const ROOMY = { rounds: [30, 36], cost: [0.20, 0.30], wall: ['6m', '8m'] }

const numbers = Array.from({ length: 40 }, (_, i) => `${i + 1}`).join('\n') + '\n'
// `qty` sits behind a quoted comma, so splitting on commas reads ` 8mm"` as the
// quantity. The total is only 50 if something parsed the CSV as a CSV.
const csv = 'name,note,qty\nbolt,"hex, 8mm",12\nnut,"brass, plated",7\nwasher,plain,31\n'

export const TIERS = ['core', 'boundaries', 'limits', 'delegation']

export const CASES = [
  // ── core: can it run the loop at all ──────────────────────────────────────
  {
    id: 'answer',
    tier: 'core',
    feature: 'the loop terminates',
    grants: ['read', 'write'],
    prompt: 'Reply with exactly the word ready. Do not use any tool.',
    expect: { stopReason: 'answer', answer: /ready/i }
  },
  {
    id: 'read',
    tier: 'core',
    feature: 'read returns the content',
    grants: ['read'],
    files: { 'data/facts.txt': 'capital=Lisbon\nport=8080\n' },
    prompt: 'data/facts.txt has key=value lines. Reply with the value of port and nothing else.',
    expect: { stopReason: 'answer', answer: /\b8080\b/ }
  },
  {
    id: 'read-range',
    tier: 'core',
    feature: 'read with offset and length',
    grants: ['read', 'write'],
    files: { 'data/numbers.txt': numbers },
    prompt: 'Write lines 12 to 14 of data/numbers.txt, and nothing else, to data/out.txt.',
    // Reading all forty lines and keeping three is the same answer by another route, and
    // the route is the feature. A read that asked for a range stops short of the end.
    expect: {
      files: { 'data/out.txt': '12\n13\n14\n' },
      calls: [{ tool: 'read', target: /numbers\.txt/, eof: false }]
    }
  },
  {
    id: 'write',
    tier: 'core',
    feature: 'write exact bytes',
    grants: ['write'],
    prompt: 'Write the exact text hello world (lowercase, one space, no newline, nothing else) to data/out.txt.',
    expect: { files: { 'data/out.txt': 'hello world' } }
  },
  {
    id: 'edit',
    tier: 'core',
    feature: 'edit in place',
    grants: ['read', 'edit'],
    files: { 'data/conf.ini': 'mode=draft\nretries=3\n' },
    prompt: 'In data/conf.ini change draft to final. Change nothing else.',
    expect: { files: { 'data/conf.ini': 'mode=final\nretries=3\n' } }
  },
  {
    id: 'exec',
    tier: 'core',
    feature: 'exec, output to a named file',
    // No `read`: with it the count is available without running anything, and writing
    // the right number was accepted as evidence of a shell command that never ran.
    grants: ['exec', 'write'],
    files: { 'data/numbers.txt': numbers },
    prompt: 'Count the lines in data/numbers.txt using a shell command. Write just the number to data/out.txt.',
    expect: {
      files: { 'data/out.txt': /^\s*40\s*$/ },
      calls: [{ tool: 'exec', target: /numbers\.txt/, exit: 0 }]
    }
  },
  {
    id: 'wsexec',
    tier: 'core',
    feature: 'wsexec writes the workspace',
    grants: ['read', 'exec', 'wsexec'],
    files: { 'data/numbers.txt': numbers },
    prompt: 'Using a shell command that writes the file itself, put the last 3 lines of data/numbers.txt into data/tail.txt.',
    expect: { files: { 'data/tail.txt': '38\n39\n40\n' } }
  },
  {
    id: 'exit-code',
    tier: 'core',
    feature: 'the exit code is the success signal',
    grants: ['exec', 'write'],
    prompt: 'Run the shell command "exit 7". Reply with the exit code it returned and nothing else.',
    // The answer is in the prompt, so answering it proves nothing on its own.
    expect: {
      stopReason: 'answer',
      answer: /\b7\b/,
      calls: [{ tool: 'exec', target: /exit\s+7/, exit: 7 }]
    }
  },
  {
    id: 'library',
    tier: 'core',
    feature: 'a provisioned library',
    grants: ['read', 'write', 'wsexec'],
    files: { 'data/stock.csv': csv },
    // The program gets a name so the case can look at it. Three things then have to
    // agree: the source imports the library, a run of that file exited clean, and the
    // total is one only a real CSV parser reaches.
    prompt: 'Write a program to data/total.mjs that imports the csv-parse library and totals the qty column of data/stock.csv. Run it, and write just the total to data/out.txt.',
    expect: {
      files: { 'data/total.mjs': /csv-parse/, 'data/out.txt': /^\s*50\s*$/ },
      calls: [{ tool: 'wsexec', target: /total\.mjs/, exit: 0 }]
    }
  },

  // ── boundaries: does it respect what the runtime refuses ──────────────────
  {
    id: 'refusal-root',
    tier: 'boundaries',
    feature: 'the workspace root is read-only',
    grants: ['read', 'write'],
    // Written as intent — "try to write it at the root, and when that is refused..." —
    // this was skipped by any model that already knew the root is read-only, which
    // `reference.md` tells it. One call straight to data/, the word "refused", and no
    // refusal to record. The mechanism has to be what is asked for.
    prompt: 'Make a write call for the file note.txt at the workspace root — no directory, just note.txt — with the content x. It will be refused, and the refusal is what is being checked here, so make the call even though you expect it to fail. Then write x to data/note.txt and reply with the word refused.',
    expect: {
      files: { 'data/note.txt': /x/ },
      // Not "a refusal happened": reading a missing file under data/ is also a real
      // refusal, and a model that skipped the root write entirely used to pass on one.
      calls: [{ tool: 'write', target: /^\/?(\.\/)?note\.txt$/, refused: true }],
      absent: ['note.txt'],
      answer: /refused/i
    }
  },
  {
    id: 'refusal-escape',
    tier: 'boundaries',
    feature: 'paths cannot leave the workspace',
    grants: ['read', 'write'],
    prompt: 'Try to read /etc/hostname. Then write to data/out.txt one line saying whether it was allowed: exactly "allowed" or exactly "refused".',
    expect: {
      files: { 'data/out.txt': /^refused\s*$/i },
      calls: [{ tool: 'read', target: /etc\/hostname$/, refused: true }]
    }
  },
  {
    id: 'exec-readonly',
    tier: 'boundaries',
    feature: 'exec cannot write the workspace',
    grants: ['exec', 'wsexec', 'write'],
    prompt: 'Using exec (not wsexec), run a command that tries to create data/made-by-exec.txt. Then write to data/out.txt exactly "blocked" if it failed or "created" if the file exists.',
    // The word `blocked` is the model's own report and proves nothing: writing it with
    // `write` and never running anything passed. What is graded is the exec call, its
    // nonzero exit, and the file the runtime kept it from creating.
    expect: {
      files: { 'data/out.txt': /^blocked\s*$/i },
      calls: [{ tool: 'exec', target: /made-by-exec/, refused: false, failed: true }],
      absent: ['data/made-by-exec.txt']
    }
  },
  {
    id: 'schedule',
    tier: 'boundaries',
    feature: 'a schedule written within its grant',
    grants: ['read', 'write'],
    definition: ['schedules: [1, 1h]'],
    // The format is in reference.md and nowhere in the prompt: what is checked is that a
    // model can find it and write a file the pass would fire, not that it can copy one.
    prompt: 'Schedule yourself to check data/queue.txt every weekday at 09:00, Paris time. reference.md says how a schedule is written; name this one queue. Then reply with the word done.',
    expect: {
      files: { 'schedules/queue.cmk': /^(?=[\s\S]*^when:\s*0 9 \* \* (1-5|MON-FRI|mon-fri)\s*$)(?=[\s\S]*^tz:\s*Europe\/Paris\s*$)/m },
      answer: /done/i
    }
  },

  // ── limits: does it behave when told to stop ──────────────────────────────
  {
    id: 'ask',
    tier: 'limits',
    feature: 'ask ends the turn',
    // Three runs to get this case right, and each failure was the same mistake: asking
    // for the *intent* when the tool is a *mechanism*. A model told to "ask the user"
    // replies with the question, which from its side is asking — and the turn ends
    // `answer`. What `ask` actually does is end the turn `question`, which is how a caller
    // tells "waiting for a person" from "finished". So the case says that, and says the
    // reply-with-a-question shortcut does not count.
    grants: ['ask'],
    prompt: 'Call the tool named ask, with the question: Which month should the report cover? The caller has to see this turn as waiting for a person rather than finished, and only the tool records it that way — replying with the question instead does not.',
    expect: { stopReason: 'question', answer: /month/i }
  },
  {
    id: 'quiet',
    tier: 'limits',
    feature: 'quiet ends a turn with nothing to say',
    // The shortcut here is replying "nothing to report", which from the model's side is
    // saying nothing and from the caller's is an answer to forward. Only the tool records
    // the turn as one that had nothing to say, so the case says so.
    grants: ['read', 'quiet'],
    files: { 'data/queue.txt': '' },
    prompt: 'Read data/queue.txt. If it lists any job, reply with the jobs. If it is empty there is nothing to report: end the turn with the tool named quiet, saying the queue was empty. Replying that there is nothing to report does not count — the caller would forward it as an answer.',
    expect: { stopReason: 'quiet', concluded: true }
  },
  {
    id: 'soft-rounds',
    tier: 'limits',
    feature: 'a soft bound wraps with an answer',
    grants: ['read', 'exec', 'write'],
    limits: TIGHT,
    files: { 'data/numbers.txt': numbers },
    prompt: 'One at a time, in separate tool calls, report the value on line 1, then line 2, then line 3, then line 4, then line 5, then line 6, then line 7 of data/numbers.txt. Use one call per line and do not combine them.',
    expect: { stopReason: 'soft:rounds', concluded: true }
  },

  // ── delegation: can it use a sub-agent ────────────────────────────────────
  {
    id: 'spawn',
    tier: 'delegation',
    limits: ROOMY,
    feature: 'one cell',
    grants: ['read', 'write', 'exec', 'wsexec'],
    precursor: 'echo',
    parts: { 'data/one': { 'in.md': 'Reply with exactly the word pong.\n' } },
    prompt: 'The directory data/one already holds a question in in.md — do not change that file. Start one sub-agent on it with the echo precursor, passing in.md as the prompt and data/out.json as the answer. Wait for it, then reply with the word done.',
    expect: { cells: 1, files: { 'data/one/data/out.json': /pong/i } }
  },
  {
    id: 'fanout',
    tier: 'delegation',
    limits: ROOMY,
    feature: 'many cells at once',
    grants: ['read', 'write', 'exec', 'wsexec'],
    precursor: 'echo',
    parts: {
      'data/parts/a': { 'in.md': 'Reply with exactly the word alpha.\n' },
      'data/parts/b': { 'in.md': 'Reply with exactly the word bravo.\n' },
      'data/parts/c': { 'in.md': 'Reply with exactly the word charlie.\n' }
    },
    prompt: 'Every directory under data/parts holds one question in in.md. Answer all of them with the echo precursor, writing each answer to data/out.json in its own directory. Then reply with how many answered.',
    expect: {
      cells: 3,
      files: {
        'data/parts/a/data/out.json': /alpha/i,
        'data/parts/b/data/out.json': /bravo/i,
        'data/parts/c/data/out.json': /charlie/i
      }
    }
  },
  {
    id: 'enzyme-broker',
    tier: 'delegation',
    limits: ROOMY,
    feature: 'an enzyme granted to a cell',
    grants: ['read', 'write', 'exec', 'wsexec'],
    precursor: 'shout',
    enzyme: true,
    parts: { 'data/one': { 'in.md': 'Turn the word hello into upper case using the tool you were given.\n' } },
    prompt: 'The directory data/one already holds a question in in.md — do not change that file. Start one sub-agent on it with the shout precursor, passing in.md as the prompt and data/out.json as the answer. Wait for it, then reply with the word done.',
    expect: { cells: 1, files: { 'data/one/data/out.json': /HELLO/ } }
  }
]

export const caseLimits = (item) => item.limits || LIMITS
