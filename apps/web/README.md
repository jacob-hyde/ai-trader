# apps/web

Laravel + Vue GUI. Not scaffolded yet; it starts with EPIC-K (lean ops GUI), which is off the critical path
to the first backtest result.

When starting K.1:

```bash
cd apps/web
composer create-project laravel/laravel .
```

Laravel owns the database schema (migrations). The engine reads and writes data only.
