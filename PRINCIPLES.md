# PRINCIPLES

These are the ideas spore is built on. Each one says what spore promises, and what it will not
do. If a change would break one of them, the principle is discussed first, here. How each idea is
built is in [ARCHITECTURE.md](ARCHITECTURE.md).

## A few words first

- **A spore** is an AI assistant that lives in its own folder on a computer. What it knows and
  what it made are in that folder.
- **A turn** is one piece of work: someone says something, the spore works on it, and it answers.
- **The model** is the large language model (LLM) the spore thinks with, such as Claude or GPT. It
  is usually paid for by use.
- **A cell** is a helper the spore creates for one narrow job. It works in a smaller folder of its
  own and reports back.
- **A precursor** is the short text file that describes a cell: its job, what it may use, and how
  much time and money it may spend.
- **A tool** is one of the seven basic actions a spore can take, such as reading a file or running
  a command.
- **An enzyme** is a small program the spore wrote and lends to a cell, by name.

## How a spore works

### 1. A spore writes programs for work that repeats

When a job repeats, the spore does not redo it by thinking each time. It writes a small program,
tests it and runs it. A program costs almost nothing to run again and gives the same result. So
the spore's real job is to write, test and run programs, and much of what follows exists to make
that easy.

### 2. One general assistant, which creates specialists

A spore can do anything it is allowed to. When a job needs focus — a narrow task, a few tools, a
small budget — the spore does not narrow itself. It writes a precursor and starts a cell from it:
a specialist made on the spot, for that one job.

There are only two levels. A cell cannot create cells of its own, and only cells receive enzymes.
One general level on top and specialists below lets the top one keep the others in check.

A program the spore wrote looks different from each side. The spore sees the file, and can change,
run and test it. A cell knows only its name and how to use it. The cell is never told where the
file is, so there is nothing to hide from it.

### 3. An enzyme is used by its name

An enzyme is a program the spore lends to a cell. The cell calls it by name, gives it some input,
and gets back its output and a result: success or failure. That is all the two sides share. So an
enzyme can be written in any programming language, and spore needs to know nothing about how it
works.

The spore never uses its own programs as enzymes. It wrote them and can see them, so it simply runs
them. A program becomes an enzyme only when it is lent to a cell, which did not write it and cannot
see it.

### 4. Only seven built-in tools

A spore has seven tools, and each one does something nothing else can: bringing a file into the
spore's attention, running a command safely, asking the person a question, ending a turn with
nothing to say. Everything else — searching files, fetching a web page, using a service that needs a
password — is done with ordinary programs on the computer. A helper program that comes with spore
is added only for a need that has been seen again and again.

### 5. Big results stay in files

When a command produces a lot of output, the output goes into a file. The spore is told that the
file exists and what it is, not shown all of it. This keeps its attention, and its bill, small. It
reads a file whole only when it chooses to. When a turn hands back work, it lists the files it made;
it does not paste them into its answer.

### 6. A copy of a spore takes its skills, not its memories

A spore holds two different things: the conversations it had, and the helpers and programs it
built. A new spore made from an old one gets the skills and none of the conversations. That also
shows whether those skills work on their own, without the history of how they were made.

### 7. A spore is described in a file, not built in code

Each spore and each cell is described by one short text file. It says which model it uses, which
tools, how much time and money it may spend, what it may read and change, and, in a few paragraphs,
who it is. Everything that makes one assistant different from another is in that file. The file is
checked strictly: an unknown word, a missing limit or an impossible value is an error, never quietly
replaced by a guess. The format is in [docs/definition.md](docs/definition.md).

Because an assistant is a text file, anything that can write a file can create one. A spore creates
a helper just by writing a precursor. In the same way, a spore itself can be created by another
program — an application making one spore per customer, say — or by another AI agent, which only has
to write a short file, with no code to learn. And a person can read, compare, review and copy an
assistant like any document. Nothing changes an assistant without the file saying so — not a hidden
setting, not a switch given at the last moment. Where something may change while it works, the file
says how far: a time or money limit can be raised only up to the ceiling the file allows.

The model is part of the file too. A cell picks between a few names its spore offers, such as
"cheap" or "strong", never a model of its own choosing. So no assistant decides by itself to spend
more, and a call to any model the file does not name is refused.

## What protects whom

### 8. Protection comes from the computer, not from good behaviour

What a spore can touch is limited by the operating system itself, and by a part of spore it cannot
reach, which holds the passwords and counts the money. No protection rests on the list of tools. The
limits a spore sets for its own helpers guide them; the limits that matter are kept where no
assistant can change them.

### 9. Spore only blocks what it can truly stop

A rule an AI can get around is worse than no rule. If spore blocked every command containing the
word "delete", the AI would simply write the same command another way: the block would protect
nothing and would get in the way of honest work. So spore does not judge commands by their words.
It refuses something only where a real barrier makes the refusal hold: the operating system stops a
write outside the spore's folder, a lock stops a second turn from starting while one runs, and the
counter of what was spent stops a turn that has used up its money.

### 10. Passwords never reach the assistant; the internet is open

No password and no paid key ever reaches a spore. Spore keeps them on a side the assistant cannot
reach and makes the calls for it, so every call to a model is counted where the assistant cannot
touch the counter.

The internet itself is open: fetching a page, calling a service or installing a package is ordinary
work for a spore's programs. So a spore can send anything it can read to anywhere. What limits that
is what it was allowed to read, and the passwords it never had. Whoever needs the network restricted
does it on the computer, outside spore.

### 11. Spore trusts the person running it, not other spores

Spore trusts the computer account it runs under. It does not trust one spore with another: each
spore is shut off from the others by design. A program the same person runs outside any spore is
outside what spore protects.

Inside one spore, the spore and all the cells it created are one team, with one key, one budget and
one set of permissions. The limits a precursor gives a cell size its work; they are not walls between
cells.

### 12. A soft limit asks to wrap up; a hard limit stops

Every limit — time, money, number of steps — comes as a pair. Past the soft one, the spore is asked
to answer with what it has and to say what is left to do. At the hard one, the work stops and no new
call to the model is made. Both count what was actually spent, never a guess of what will be. A call
already under way is never cut off: the turn waits for it, pays for it, and may end a little past
its limit because of it. Only the computer's owner can set a time after which a call is cut.

### 13. A spore cannot rewrite its own history

A spore cannot change its own description file or erase the record of what it did. Its records are
written by the part of spore that watches over it. This is not about limiting what it can do; it is
about being able to check, afterwards, what it did.

### 14. The computer's limits belong to its owner

Limits that protect the computer — how many spores work at once, how big a file may grow, how much
disk must stay free, how much may be spent in a day — are set by the computer's owner, once for all
spores, and not in each spore's file. A spore writing a helper must not decide how safe the computer
is. When a limit is reached, spore says no; it keeps no waiting line. Whoever asked decides when to
try again.

## Where things live

### 15. The folder is the spore

Everything about a spore is in its folder: its description, its records, its files. There is no
separate session to resume, and no list of what is running. Whether a spore is working right now is
asked of the operating system, which always knows.

### 16. Every message lands in the same inbox

A person's message, a scheduled reminder, an alert from another service, the end of a long task:
each one is added to the spore's inbox. Starting work on it is a separate step. If the spore is
already working, the new message joins that work; if not, a turn starts. There is no other way in.
Spore never looks for magic words in a message: what a message means is for the spore to decide.

### 17. Spore watches; it runs no central service

There is no central program that keeps track of every spore, no queue and no shared database. What a
spore is doing is in its folder and known to the operating system, and everything that shows it — the
command line, a chat bot, a program talking to spore over the network — reads it from there. An
application serving many spores watches them the same way.

## How spore is made

### 18. Each rule is written once

Each rule lives in one place: one reader of description files, one way of locking a folder, one way
of keeping each record, used by every part of spore.

### 19. Each default is written once

A default value lives in one place: the description file that comes with spore, or the documented
setting of the computer. The code never keeps a second opinion. A missing limit is an error, not
silently filled in. Where "nothing set" has a meaning of its own, it is a real answer, not a number
standing in for one.

### 20. Complete or not at all

The worst result is one that looks complete but is not. So a record either fits whole or is
refused. An unfinished answer from a cell is marked as unfinished, or replaced by a note of what
remains. A copy taken from a moment in the past is refused if a file has changed since.

### 21. When something fails, it says so

A failure is never silent. A tool that cannot work is not offered. A missing part of the
installation says it is missing. Work that crashed is recorded as crashed. And an error message says
how to fix the problem, not only which rule was broken.

### 22. When in doubt, start narrow

When a choice is easy to widen later but hard to take back, spore takes the narrow one and says so.
It accepts exact names, for example, before it accepts patterns.
