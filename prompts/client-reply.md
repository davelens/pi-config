---
description: Draft a client-facing reply in Dutch about the current work
argument-hint: "[max words] [focus]"
---
Draft a reply to the client about this session's findings and changes. ${@:2}

- Dutch, plain language for a non-technical reader; no code, class, table or file names.
- At most ${1:-100} words. Lead with the answer or outcome, then what changes for them, then anything they must do or decide.
- Only state what this session verified; mark assumptions as such.

Write it as plain text (no Markdown) to `tmp/client-reply.md`, copy it to my clipboard with `if [ -n "$TMUX" ]; then tmux load-buffer -w tmp/client-reply.md; else wl-copy < tmp/client-reply.md; fi`, and show it as a plain paragraph, not a blockquote.
