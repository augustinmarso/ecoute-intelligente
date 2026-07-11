# Écoute Intelligente

Améliore ton anglais en regardant des vidéos YouTube : capture une phrase d'un bouton (screenshot + audio du passage + traduction) vers Anki, les mots difficiles partent automatiquement en cartes de vocabulaire, et une page d'exercices IA te fait retraduire des phrases avec tes mots. App sœur de [Lecture Intelligente](https://github.com/augustinmarso), même design papier/corail.

## Fonctionnalités

- **Lecteur YouTube sous-titré** : la phrase courante s'affiche en grand sous la vidéo (police au choix : Lexend, Atkinson Hyperlegible ou OpenDyslexic — pensé pour la dyslexie).
- **Touche C** : capture la phrase → carte Anki recto (image + audio du passage, découpé au mot près) / verso (texte anglais + traduction française). Les mots difficiles de la phrase (hors 5000 mots les plus courants) partent automatiquement en cartes mots.
- **Clic sur un mot** : la vidéo se met en pause, le mot affiche sa traduction française (dictionnaire Wiktionnaire, pas de traduction automatique) et part dans Anki.
- **Galerie « Mes cartes »** : toutes les cartes phrases et mots créées, avec lecture audio.
- **Exercices IA** : phrases françaises générées à partir de tes mots Anki (présent/passé/futur), à retraduire en anglais à l'écrit ou à l'oral, correction notée sur 10 (clé API Claude ou OpenAI à coller dans l'app, stockée en local).
- **Gamification** : XP, niveaux, série quotidienne, badges.

## Prérequis

- [Node.js](https://nodejs.org) ≥ 18
- [Anki](https://apps.ankiweb.net) avec l'add-on [AnkiConnect](https://ankiweb.net/shared/info/2055492159) (code `2055492159`), Anki ouvert pendant l'utilisation
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) : `pip install yt-dlp`
- ffmpeg : fourni automatiquement (`ffmpeg-static` via npm)

## Lancer

```bash
npm install
npm start
```

Puis ouvre <http://localhost:3311>, colle une URL YouTube (avec sous-titres anglais) et c'est parti.

## Notes techniques

- Aucune vidéo n'est téléchargée : l'image et l'audio d'un passage sont extraits directement des URL de stream (`yt-dlp -g` + ffmpeg).
- Les bornes audio sont affinées au mot près grâce aux horodatages mot-à-mot des sous-titres automatiques.
- Les traductions de mots viennent du Wiktionnaire francophone (avec suivi des formes fléchies) et des liens interlangues Wikipédia — jamais d'un traducteur automatique.
- Decks créés automatiquement : `Écoute Intelligente::Phrases` et `Écoute Intelligente::Mots`.
