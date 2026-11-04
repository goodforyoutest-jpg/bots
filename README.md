# Stephen bot runner

Runs your bots online (a real headless Chromium) when you choose "Run online" in the app.

## Render
1. Put this folder in a GitHub repo (or the Stephen repo's bot-runner folder).
2. Render → New → Web Service → Docker. Root directory: bot-runner.
3. Environment: RUNNER_TOKEN = a long random secret.
   Optional logins for online runs: LOGINS = {"mysite":{"site":"example.com","user":"me","pass":"secret"}}
4. In the app: Bots → Online → paste the Render address and the same token → Test connection.

Moving host later: change the address and token in the app. No rebuild.

Notes: the free Render tier sleeps; the first run can take about a minute to wake. Login passwords for online runs live in this server's environment, not on the phone. The chosen AI's key is sent to this runner per run, so only use a runner you control.

## Fixed-step recipes (no AI)
"Run without API" sends the bot's typed steps here and they run in the headless browser with no AI key. Logins for these runs come from the LOGINS variable.
