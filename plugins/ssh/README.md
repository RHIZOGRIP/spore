# @rhizogrip/spore-plugin-ssh

SSH for spores: the keys a host's `ssh-agent` holds, which a spore's `ssh` and `git` can use and
never read. For any SSH service — a forge, GitHub, a server.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```
npm i -g @rhizogrip/spore-plugin-ssh
spore plugin allow ssh socket=/run/user/$(id -u)/spore-ssh-agent.socket
```

The socket is the one `spore service define ssh-agent` sets up, below; it prints this line.

A spore uses it once its `spore.cmk` says `plugins: [ssh]`. Its agent is given `SSH_AUTH_SOCK`,
pointing at the agent below, and `$SPORE_SSH` — also `GIT_SSH`, so git uses it — an `ssh` that
keeps known hosts and config in the workspace's `home/.ssh/`. It reads how to use them in `plugins/ssh.md`.

## The agent, on the host

The keys stay in `~/.config/spore/ssh/`, beside `config.json`, which the sandbox never grants;
only the agent's socket reaches a spore, and the ssh-agent protocol signs with a key and never
hands one out. `spore service` runs the agent, as the user spores run under:

```
mkdir -m 700 -p ~/.config/spore/ssh
ssh-keygen -t ed25519 -N '' -C 'git.example.org as spore-bot' -f ~/.config/spore/ssh/spore-bot
spore service define ssh-agent        # checks the keys, writes the unit, prints the enable line
spore service start ssh-agent && spore service enable ssh-agent
```

Every private key in that folder is loaded when the service starts. A key has no passphrase —
nobody is there to type one — and `define` refuses one that has. To add or retire a key, put it
in the folder or take it out, then `spore service restart ssh-agent`.

What a spore can do with a key is decided here, where it cannot change it:

- **Which keys**: what is in `~/.config/spore/ssh/`. The comment is what the agent sees in
  `ssh-add -l`, so say there what the key is for.
- **Which repositories**: give the key its own account on the service, with access to what the
  spore should touch and nothing else, and protect the branches it should not push to.

**The socket is shared on trust.** Any process of that user can connect to it — every spore it
runs, whether its definition names this plugin or not. `plugins: [ssh]` says which spores are
told about the keys, not which can reach them. Load only keys you would hand to every spore of
that user.
