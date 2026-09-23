# Stem separation service

Backend for Song Studio's **Split Stems**. The editor bundle calls
`http://localhost:8787/api/studio/separate`; this service answers it.

```powershell
pip install -r requirements.txt
.\run.ps1          # or run.cmd
```

Then open <http://localhost:8787/api/health>.

| File                   | Purpose                                        |
|------------------------|------------------------------------------------|
| `app.py`               | FastAPI routes, job storage, CORS              |
| `demucs_separator.py`  | Hybrid Transformer Demucs backend (optional)   |
| `dsp_separator.py`     | NumPy/SciPy fallback, no model needed          |

Full documentation: [`../docs/SONG_STUDIO.md`](../docs/SONG_STUDIO.md).
