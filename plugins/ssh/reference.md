# SSH: keys you can use and never read, for git and ssh to the hosts your operator allows

Your operator keeps SSH keys in an agent outside your workspace, and `$SSH_AUTH_SOCK` lets `ssh`
and `git` use them. You can sign with a key; you cannot read one, and there is no file of it
anywhere you can reach. Do not look for one.

```
ssh-add -l          the keys you can use, each with the comment your operator gave it
```

What that prints — a fingerprint and a comment — is public, derived from the public key your
operator gave the service. Show it when asked. Only the private key is secret, and it is not
anywhere you can reach.

The comment usually says what a key is for — a host, an account. A key can also be limited to
one host, and then it is refused everywhere else. `The agent has no identities` means no key is
loaded, and `Could not open a connection to your authentication agent` that the agent is not
running: say so and stop, since nothing you can do loads one.

## Reaching a host

`ssh` does not find its files through `$HOME`: it reads `~/.ssh/known_hosts` and `~/.ssh/config`
from your operator's account, outside your workspace, and is refused there. So you are given an
`ssh` that uses your own, in `home/.ssh/`: `"$SPORE_SSH"`. git uses it by itself.

```
"$SPORE_SSH" git@git.example.org                 a connection
scp -S "$SPORE_SSH" data/out.tar host:/srv/in/   a copy
rsync -e "$SPORE_SSH" -a data/site/ host:/srv/site/
```

The first time a host is reached, its key is recorded in `~/.ssh/known_hosts`; a host whose key
has changed since is refused. A host on another port, or under another name, goes in
`~/.ssh/config`, which `"$SPORE_SSH"` reads:

```
Host forge
  HostName git.example.org
  Port 2222
  User git
```

Make the folder once, with `wsexec`, since it writes your `home/`:
`mkdir -p ~/.ssh && chmod 700 ~/.ssh`.

## Working with a repository

Clone into `data/`, with `wsexec`, and give git a name to commit under once. A large repository
takes longer than a command's default time: give the call a longer `timeout`, or clone with
`--depth 1` when the history is not needed.

```
git clone ssh://git@git.example.org:2222/team/project.git data/project
git config --global user.name "…" && git config --global user.email "…"
```

Push your work to a branch of its own and say which in your answer. The default branch is for
whoever reviews it, unless the message you were given says otherwise. Never force-push a branch
you did not create.
