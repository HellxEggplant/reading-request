# ECDICT data

`ecdict.sqlite` is a read-only SQLite conversion of `ecdict.csv` from
[skywind3000/ECDICT](https://github.com/skywind3000/ECDICT).

- Source format: UTF-8 CSV
- Imported entries: 770,611
- Usage in this project: local English-to-Chinese dictionary lookup
- License: MIT; see `ECDICT-LICENSE`

The source CSV is not kept in the project after conversion.

For the GitHub Pages build, `ecdict-shards/` contains about 59,000 commonly
used entries selected by ECDICT frequency, exam, Oxford, and Collins metadata.
The browser loads only the two-letter shard needed for the word being queried.
