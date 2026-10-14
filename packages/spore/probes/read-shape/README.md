# read-shape

Does the form a `read` result takes change what a model gets right? Each item is a question
about one file, asked after one `read` of it, and every item is asked in arms that differ only in
how that result is shown:

- `record`: what an agent is shown today, made by the runtime's own `read` and tool kernel;
- `plain`: the same record without `content` on one JSON line, then the file's text as it is;
- `numbered`: that line, then the text with `cat -n` line numbers, counted from the read's offset;
- `numbered-record`: the runtime's read with `numbered` set: `17→` before each line of `content`;
- `choose`: the model makes the read itself; the item is then asked in `numbered-record` if it
  set `numbered`, in `record` if not. Two calls per item, and the
  report says how often it asked and how often it was right either way.

The tasks, each graded against the file:

| task | asks | right when |
|---|---|---|
| `locate` | the line a phrase is on; half the reads are slices | the number is the line's |
| `quote` | the line holding a phrase, every character | it is the line, byte for byte |
| `delete` | delete that line with `edit` | the file is the file without it |
| `insert` | add a given line after it with `edit` | the file has it there, in the file's line ending |
| `continue` | after a slice, `end` or the line to read next | it is the right one |

The corpus (`corpus/`) is chosen for what escaping touches: JavaScript with quotes and
backslashes, a Makefile's tabs, markdown prose, CSV with quoted fields, an INI file with CRLF
line endings, trailing spaces and no final newline, and French text.

```bash
node probes/read-shape/run.js --dry
node probes/read-shape/run.js --show settings.ini:quote:0
node probes/read-shape/run.js --models openai/gpt-6-luna,anthropic/claude-sonnet-5-5
node probes/read-shape/run.js --report ../tmp/read-shape/<run>
```

Calls go through mohdel's in-process factory, with its catalog and keys, and cost money. Each
run is kept in its own directory with `run.json` and every answer in `results.jsonl`. The report
compares arms item by item: for each pair, the items only one of them got right, and a sign
test on that split. `test/read-shape-probe.test.js` checks the items and the grader offline.
