# Security

Never commit an OpenRouter API key, OpenCode auth file, or environment file.

Configure credentials outside this repository:

```sh
export OPENROUTER_API_KEY="sk-or-v1-..."
```

If a key is exposed, revoke it in OpenRouter immediately and create a new one.
Please report suspected security issues privately through the repository's
GitHub security contact instead of opening a public issue with credentials.
