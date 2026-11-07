// Pliki klienta z tego samego procesu co API. Tylko obraz Dockera na Oracle ustawia CLIENT_DIR (deploy/oracle/Dockerfile);
// na Renderze klient ma własne witryny, a lokalnie serwer Vite.
import path from 'path';
import express from 'express';
import type { Express } from 'express';

export const serveClient = (app: Express, clientDir: string) => {
  app.use(express.static(clientDir, {
    index: false,
    // .well-known/assetlinks.json dla aplikacji Android
    dotfiles: 'allow',
    setHeaders: (res, file) => {
      // Pliki /assets/ mają hash w nazwie. Reszta, w tym sw.js i manifest, jest zawsze sprawdzana, inaczej nowa wersja nie dotrze do PWA.
      const hashed = path.relative(clientDir, file).split(path.sep)[0] === 'assets';
      res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));

  // Aplikacja jednostronicowa: nieznana ścieżka to index.html. Poza /api (sterowniki rozpoznają tam 404 i 409)
  // i /assets (brakujący plik skryptu nie może dostać strony HTML z kodem 200).
  app.get(/^(?!\/(api|assets)(\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: clientDir });
  });
};
