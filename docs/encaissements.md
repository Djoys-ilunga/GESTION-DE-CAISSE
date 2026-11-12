# Caisses et encaissements — étape 4

## Utiliser le module

Une entreprise peut conserver une seule caisse ou en ajouter plusieurs, sans changement de modèle. Les choix uniques sont présentés automatiquement sans sélecteur superflu ; voir [la configuration monocaisse/multicaisse](configuration-caisses.md).

Sur le serveur de développement, depuis la racine :

```sh
pnpm install --frozen-lockfile
pnpm setup:env
pnpm db:generate
pnpm db:up
pnpm db:deploy
pnpm dev
```

Toutes les migrations versionnées doivent être appliquées avant l’utilisation. Les bases existantes ne sont pas réinitialisées. Pour une nouvelle entreprise, suivre la [création du premier administrateur](authentification.md#créer-le-premier-administrateur). L’aperçu `pnpm dev:web` ne permet toujours aucune authentification réelle : ouvrir l’application Tauri pour travailler.

1. **Administrateur : « Caisses → Configuration des caisses ».** Créer les agences, puis leurs caisses et les utilisateurs autorisés initialement. Chaque caisse reçoit deux comptes de trésorerie distincts, CDF et USD, et leurs contreparties techniques. Aucun solde initial n’est créé. L’agence et le code de caisse restent fixes ; le nom et l’activation se modifient avec contrôle de version.
2. **« Utilisateurs ».** Pour les affectations ultérieures, modifier les agences/caisses et les rôles de l’utilisateur. Une affectation nouvelle révoque les sessions concernées : l’utilisateur doit se reconnecter. Les rôles ne sont pas élargis implicitement par une affectation.
3. **Caissier ou responsable financier autorisé : « Caisses ».** Ouvrir la session de caisse en ligne. Une ouverture répétée ou concurrente retrouve la même session ouverte. Plusieurs utilisateurs affectés peuvent travailler dans cette session. Les clôtures font partie d’une étape ultérieure ; aucun bouton de clôture définitive n’est ajouté ici.
4. **« Encaissements → Nouveau brouillon d’encaissement ».** Choisir la caisse, le montant exact avec deux décimales, la devise, la provenance, la catégorie, le motif et, si disponible, une référence et un justificatif. Enregistrer le brouillon. Le statut est **« Brouillon non comptabilisé »** : aucun solde ni reçu n’est créé.
5. **Transmettre les brouillons.** La transmission peut aussi intervenir après revalidation périodique de la session ou retour réseau. Le serveur enregistre un brouillon privé avec son UUID stable et sa version. Cette action ne confirme pas la réception d’argent.
6. **« Suivi serveur → Vérifier et confirmer ».** Vérifier le montant, la devise, la provenance et le motif, puis cocher l’attestation de réception effective. Une caisse active, une session de caisse ouverte et la permission `receipt:post` sont obligatoires. Le bouton **« Confirmer et comptabiliser »** déclenche la transaction financière.
7. **Reçu et historique.** Le serveur renvoie le reçu numéroté. L’historique se filtre par caisse, devise, catégorie, période, provenance, motif, référence ou numéro. Les journées des filtres et les dates affichées utilisent le fuseau **Africa/Kinshasa**. Une caisse désactivée conserve ses soldes et ses reçus consultables par les personnes toujours affectées ; elle refuse de nouveaux encaissements.

Les soldes de l’écran « Caisses » sont relus auprès du serveur toutes les **5 secondes** en ligne, et ceux du parcours d’encaissement après confirmation. C’est un rafraîchissement périodique, sans promesse de diffusion WebSocket instantanée. Chaque consultation affiche sa date. CDF et USD ne sont jamais agrégés en un montant commun.

## Confirmation, reçu et concurrence

La confirmation envoie uniquement l’identifiant du brouillon serveur, sa version attendue et `received: true`. Le montant, la devise, la caisse et les métadonnées sont relus sur le serveur ; le client ne fournit aucun solde, numéro de reçu, compte de contrepartie ou identité comptable.

Une transaction SERIALIZABLE unique vérifie la session, les permissions et les affectations, verrouille le brouillon et les ressources, puis crée le mouvement équilibré, ses deux écritures, l’audit et l’instantané du reçu. La clé d’idempotence comptable est l’UUID du brouillon **central**, distinct des versions et des sessions de connexion. Une seule relation reçu/brouillon et reçu/opération est possible. Six confirmations concurrentes du même brouillon produisent un seul encaissement.

La séquence est centralisée par entreprise et année UTC : `REC-CODEENTREPRISE-2026-000001`. Le compteur avance dans la même transaction, avec contraintes SQL au commit ; un échec annule aussi les écritures et le numéro. Les confirmations de plusieurs caisses/devises partagent cette séquence d’entreprise. Le numéro ne constitue pas une signature numérique ni une certification fiscale.

Le reçu conserve les noms de l’entreprise, de l’agence, de la caisse et du caissier au moment de la confirmation. Une modification ultérieure de configuration ne réécrit pas ces informations. Reçu, mouvement et écritures sont immuables ; le brouillon source confirmé ne peut plus être édité ou renvoyé avec un contenu différent. Une correction financière doit utiliser les mécanismes de contre-écriture ; aucun écran de correction ou d’annulation comptable n’est livré dans cette étape.

Après un délai réseau ou une erreur de confirmation, **consulter le suivi serveur et l’historique**. La transaction peut avoir abouti sans que la réponse soit arrivée. Réessayer la confirmation du même brouillon retrouve le même reçu. Ne pas créer un nouveau brouillon pour cette même réception incertaine. Le retour du réseau ne déclenche jamais de confirmation automatique.

## Brouillons et mode hors connexion

Le stockage actif est affiché par l’interface. Sur les cibles qualifiées à l’étape 13-B, les brouillons, leurs justificatifs enregistrés et les caches autorisés sont chiffrés dans SQLCipher, avec clés dans le coffre système. Les autres cibles restent en mémoire native. Le WebView reste privé ; aucun fichier SQLite en clair, clé frontend, jeton dans Web Storage ou export automatique n’est ajouté. Voir [le bilan 13-B](etape-13b/BILAN.md).

L’accès hors connexion conserve les règles de l’étape 3 : session en ligne préalable dans le même processus, permission `offline:access`, déverrouillage local et durée maximale de quinze minutes depuis la validation serveur. Le verrouillage automatique et les effacements de sécurité restent applicables. Les informations sont explicitement marquées non actualisées ; leur date correspond à la dernière réponse serveur, pas à l’heure de lecture hors réseau.

En coupure, préparer ou modifier un brouillon est possible, y compris joindre un fichier choisi par l’utilisateur. La confirmation, l’ouverture de session de caisse, la configuration, la consultation de l’historique central et la génération/impression d’un reçu sont bloquées. Aucune écriture ni augmentation de solde officiel n’est effectuée.

**Dans le mode chiffré qualifié, les brouillons enregistrés se récupèrent après fermeture, au plus sept jours.** Le redémarrage commence verrouillé ; après expiration du bail ou déconnexion, une authentification serveur du même auteur est nécessaire. Un changement d’utilisateur ne donne jamais accès aux brouillons précédents. En mode mémoire uniquement, la fermeture les efface toujours. Un brouillon transmis existe durablement sur PostgreSQL. Après une nouvelle authentification en ligne, « Suivi serveur → Reprendre le brouillon » le recharge dans une nouvelle période locale autorisée, avec le même UUID et la même version serveur. Une modification locale non transmise ne doit pas être écrasée par ce rechargement. Un brouillon confirmé est accessible par son reçu et ne peut plus être repris pour édition.

La revalidation précède la transmission et la confirmation. Les générations de session empêchent une réponse ancienne de modifier les données du nouvel utilisateur. Le chargement asynchrone d’un justificatif est annulé si son formulaire disparaît lors du changement d’utilisateur. Une révocation inconnue pendant une coupure reste bornée par le bail local, comme décrit dans [authentification.md](authentification.md).

## Justificatifs et impression

Un justificatif facultatif est accepté en **PDF, PNG ou JPEG, jusqu’à 1 Mio**. Le nom, le type déclaré, la taille, le Base64 canonique et l’en-tête sont contrôlés côté Rust et serveur ; PostgreSQL impose également la cohérence des octets, du type non nul et de l’empreinte SHA-256. Une simple extension renommée ne suffit pas. Ces contrôles d’en-tête ne remplacent pas un antivirus ou une analyse complète de document, qui ne sont pas livrés ici.

Avant transmission, les octets restent en RAM. Après transmission ils sont enregistrés en `bytea` dans PostgreSQL, puis figés dans l’instantané du reçu à la confirmation. Les listes et historiques omettent les octets. L’accès au contenu confirmé exige la permission de lecture et une affectation à la caisse ; les brouillons restent privés à leur auteur. Aucune URL publique de fichier ni chemin local n’est exposé.

Les images sont consultables en mémoire dans le reçu. Pour les PDF, cette version affiche les métadonnées et conserve les octets côté serveur ; elle ne propose pas de prévisualisation PDF intégrée ni de téléchargement local de justificatif. L’impression du **reçu confirmé** est une action explicite via le dialogue du système. L’application ne crée aucun PDF financier automatiquement sur disque. La destination choisie dans ce dialogue dépend du système de l’utilisateur.

Le rendu d’impression A4 a été vérifié dans Chromium sur un reçu **synthétique** : PDF d’une page et capture inspectée. L’impression physique et le dialogue natif Windows/macOS restent à qualifier. Cela ne valide ni les installateurs ni l’activation du stockage local chiffré. La protection des sauvegardes et du stockage physique PostgreSQL relève de la configuration du serveur ; `bytea` ne constitue pas un chiffrement à lui seul.

## Services et vérifications

| Route privée                                                                 | Responsabilité                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /cash/configuration`, `POST /cash/agencies`, `POST/PUT /cash/registers` | Configuration par administrateur, contexte entreprise serveur          |
| `GET /cash/registers`                                                        | Soldes exacts et sessions des caisses affectées, y compris désactivées |
| `POST /cash/registers/:id/open`                                              | Ouverture de session de caisse autorisée et idempotente                |
| `POST /workspace/drafts/sync`                                                | Transmission privée de brouillons, jamais comptabilisation             |
| `GET /cash/drafts`, `GET /cash/drafts/:id`                                   | Suivi/reprise des brouillons de l’auteur                               |
| `POST /cash/drafts/:id/confirm`                                              | Attestation, transaction financière et reçu unique                     |
| `GET /cash/receipts`, `GET /cash/receipts/:id`                               | Historique filtré et reçu immuable autorisé                            |
| `GET /cash/receipts/:id/evidence`                                            | Contenu du justificatif confirmé, sans cache HTTP                      |

Toutes les routes sont préfixées par `/api/v1`. Les commandes Tauri supplémentaires sont des actions limitées et autorisées, sans proxy HTTP arbitraire. La pagination des transmissions et de l’historique est de 25 éléments ; le catalogue de configuration est limité à 200 utilisateurs et 500 caisses. Le compte API de production reste un LOGIN restreint NOINHERIT/NOBYPASSRLS, membre des rôles d’exécution, avec migration/provisionnement séparés.

Vérifications : `pnpm check`, `pnpm test:db`, `pnpm test:session`, `pnpm test:auth:desktop`, `pnpm test:local`, `pnpm test:api:live`, `pnpm test:e2e`, `pnpm check:rust`, puis compilation Tauri et contrôle de fenêtre Linux. Le parcours `test:auth:desktop` couvre désormais aussi la configuration d’une caisse, la reprise dans un nouveau courtier, la confirmation explicite unique, l’historique et les soldes réels. Il s’exécute exclusivement sur une base PostgreSQL temporaire avec un LOGIN API restreint.

Voir [validation.md](validation.md) pour les résultats effectivement obtenus et la distinction entre PostgreSQL réel, transport Rust réel, doubles d’interface et qualifications natives restantes.
