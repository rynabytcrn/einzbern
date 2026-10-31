<div align="center">

# Mana Orchestrate

Le Graal exauce les vœux ; Mana Orchestrate fait couler le mana au bon endroit, au bon moment.

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Français**

![release](https://img.shields.io/badge/release-{{version}}-blue?style=flat-square) ![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![skill](https://img.shields.io/badge/skill-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20DeepSeek%20Harness-informational?style=flat-square) ![engine](https://img.shields.io/badge/engine-Einzbern-9cf?style=flat-square)

[Il fait trois choses](#il-fait-trois-choses) · [Installation](#installation) · [Une fois en place](#une-fois-en-place) · [Comment nous réduisons votre consommation](#comment-nous-réduisons-votre-consommation) · [Version](#version) · [Ce qu'il contient](#ce-quil-contient)

</div>

> [!TIP]
> `npx skills add tpmoonchefryan/mana-orchestrate`, puis dites à votre hôte « installe Einzbern » dans le projet.

---

C'est le skill qui amène Einzbern dans Claude Code, Codex et DeepSeek Harness. Einzbern est la mémoire de projet de ces trois hôtes : éléments de travail, connaissances et comptes rendus apparaissent devant le modèle avant le prompt qui en a besoin. Le mana est la mémoire en circulation ; orchestrer, c'est décider quand elle coule et vers où. Ce skill apprend au modèle quand appeler quelle fonction du moteur, et embarque l'assistant d'installation.

## Il fait trois choses

**Il fait entrer Einzbern.** Vous dites à votre hôte « installe Einzbern » et l'assistant prend la main : un écran de questions, une confirmation, moteur téléchargé et vérifié, hook branché, les deux hôtes réglés en une passe.

**Il dit au modèle quand faire quoi.** Une table de navigation : rappeler la mémoire avant de commencer, reporter le résultat dans l'élément de travail une fois fini, noter les décisions en comptes rendus, écrire les leçons en cartes. Le moteur génère la table pour sa propre version, si bien que chaque verbe lu par le modèle correspond à un verbe du moteur.

**Il ne détient rien.** Ni données, ni règles, ni configuration. La mémoire vit dans la bibliothèque partagée `Ether`, sous un dossier parent choisi par l’utilisateur ; les projets sont séparés par leur identité et les bibliothèques de projet `.ether` existantes restent utilisables. Les principes et les variables vivent dans Atelier, l’atelier d’un mage, ici la page de gestion locale. Le skill n’est que cette table et cet assistant.

## Installation

Avec la commande skills :

```
npx skills add tpmoonchefryan/mana-orchestrate
```

Ou dites à votre hôte : trouve un skill nommé Mana Orchestrate et installe-le.

Il se place dans le répertoire des skills de l'hôte, `~/.claude/skills` pour Claude Code et `~/.agents/skills` pour Codex et DeepSeek Harness. Dans DeepSeek Harness, le rappel avant chaque prompt passe par le plugin dsh-mana-orchestrate ; aucun fichier de hook n'est écrit. Puis, dans le répertoire du projet, dites : installe Einzbern.

L’assistant demande : installation neuve ou restauration depuis une bibliothèque existante, où placer `Ether`, si ce dossier est synchronisé dans le cloud, quelle langue, et s’il faut écrire une section de navigation dans AGENTS.md. `Ether` est le nom du dossier ; vous choisissez son parent sur un disque local, externe ou dans un dossier synchronisé. Les projets suivants réutilisent par défaut cet emplacement enregistré. Il liste ensuite chaque fichier qu’il s’apprête à écrire, et vous confirmez une seule fois. Le moteur est téléchargé depuis la release qui porte la même version que ce skill et vérifié contre son empreinte avant d’être posé ; avec une archive locale, il s’installe hors ligne.

Tout ce qui suit est un mode du même assistant : mise à jour, réparation, migration depuis TCRN Workflow, désinstallation, bilan de santé. Dites « mets à jour Einzbern », et c'est tout.

Il ne commite pas, ne pousse pas, ne modifie pas votre .gitignore, ne supprime rien, et ne touche au réseau que pour télécharger le moteur.

## Une fois en place

Vous travaillez comme d'habitude. Avant chaque prompt, l'hôte le confie au moteur pour une recherche ; les titres fortement liés entrent dans le contexte, sinon il ne se passe rien. Le modèle note aux bons moments, en suivant la table de navigation. Pour voir ou changer quelque chose, ouvrez Atelier.

## Comment nous réduisons votre consommation

> **Le workflow dédié à Codex est disponible.** Codex Desktop utilise deux conversations indépendantes : une de décision au palier principal et une de coordination au palier économique. Les autres hôtes conservent leurs parcours natifs. Les coûts ci-dessous ont été calculés le 2026-10-31 à partir d'échantillons historiques ; ces comparaisons reposent sur des hypothèses d'estimation et ne promettent pas une économie de quota fixe.

Les tâches longues consomment des ressources au-delà de l'écriture du code. La délégation, la reprise après une attente, la récupération de l'état, la lecture des journaux et la réception des résultats des sous-agents peuvent toutes amener le modèle à traiter le contexte à répétition. Einzbern et Mana Orchestrate contrôlent ces coûts par la répartition des tâches, les limites des lots et le périmètre du contexte.

- **Choisir la catégorie de modèle selon la tâche.** La planification, les jugements complexes et l'acceptation indépendante commencent au palier principal ; l'exécution bien délimitée et la coordination courante utilisent le palier économique configuré. La politique de l'hôte détermine le modèle et l'effort de raisonnement effectifs, sans imposer un modèle fixe.
- **Exécuter un objectif par lot entier.** Après le découpage, les tâches sont regroupées selon leurs dépendances. Les agents exécutants terminent leur travail ; l'acceptation et le traitement des problèmes sont regroupés en fin de lot, ce qui réduit les échanges répétés de clôture, de délégation et d'acceptation pour chaque élément.
- **Ne lire que le nécessaire.** Les problèmes et les preuves restent dans les dossiers du lot. La conversation principale reçoit les résultats et les emplacements des preuves utiles à ses décisions ; les gros fichiers, journaux et plans sont lus par extraits.
- **Compter tous les rôles dans le coût.** La conversation principale, les conversations de coordination économique et les agents exécutants sont comptés ensemble, échecs, nouvelles tentatives et retours compris. Une baisse de consommation de la conversation principale s'évalue au regard du workflow entier.

### Une coordination adaptée à chaque hôte

| Hôte | Méthode | Objectif d'optimisation et éléments observés |
| :--- | :--- | :--- |
| **Codex Desktop : workflow dédié à deux conversations** | Une conversation de décision indépendante au palier principal transmet l'objectif du lot entier. Une conversation indépendante au palier économique délègue aux sous-agents exécutants, attend et recueille leurs résultats, puis fait un seul retour au palier principal en fin de lot. | Les exécutions historiques montrent un coût sensible lorsque la coordination fréquente reste dans une longue conversation au palier principal. Confier ce travail au palier économique permet de contrôler la fréquence des appels à la conversation principale. |
| **Claude Code : parcours natif conservé** | Une seule conversation principale coordonne les sous-agents exécutants avec l'exécution en arrière-plan et les notifications de fin de l'hôte. | Les notifications natives ramènent les résultats. Les optimisations portent ensuite sur les catégories de modèles, les réveils programmés, le contenu retourné et le rythme d'acceptation. Les échantillons actuels ne démontrent pas un besoin général de conversation de coordination distincte. |
| **DeepSeek Harness : parcours natif conservé** | Une seule conversation principale utilise les sous-agents gérés par le runtime ; le plugin Mana Orchestrate assure l'intégration de la mémoire et la déduplication du pont. | Le runtime gère les notifications de fin et la libération des ressources. Les journaux historiques montrent déjà plusieurs retours regroupés dans une seule réponse principale. Les optimisations supplémentaires s'évaluent selon les modèles réels et la part du coût de coordination. |

Cette forme à deux conversations est **l'unique workflow Codex** ; elle remplace l'ancien parcours fondé sur le hook collecteur, sans modifier les autres hôtes. La coordination économique reçoit directement les résultats des exécutants, sans agent collecteur distinct. L'implémentation, l'intégration et l'acceptation indépendante incombent aux agents exécutants correspondants. Les catégories principale et économique sont obligatoires ; la catégorie phare est facultative.

Le modèle réalise cette orchestration avec les outils de l'hôte. Le moteur enregistre les lots et les reçus ; il ne crée pas lui-même de conversations, ne délègue pas de tâches et n'envoie pas de messages.

Codex prend lui-même en charge les sous-agents, l'attente et l'agrégation des résultats. Le workflow dédié répond aux coûts de coordination observés. Conserver les parcours natifs de CC et DSH ne signifie pas qu'ils n'ont aucun retraitement du contexte lors des retours ni qu'ils n'auront jamais besoin d'optimisation. Voir les documentations des [sous-agents Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents), des [sous-agents Claude Code en arrière-plan](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) et de la [délégation native DSH](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md).

### Un cas Codex : trois méthodes estimées à consommation identique sur 29,3 heures

Un journal de développement de design system couvre **29,3 heures, 81 conversations et 7 763 réponses uniques du modèle**, décisions principales, coordination économique et ensemble des exécutants compris. Le travail était encore en cours à la fin de l'échantillonnage. Les chiffres décrivent cette fenêtre, pas le coût complet d'une livraison ayant passé l'acceptation finale.

| Méthode | Credits de référence Standard | Coordination principale = 100 % | Nature des données |
| :--- | ---: | ---: | :--- |
| **Décision principale + coordination économique + exécutants affectés par catégorie** | **2 610,58** | **49,3 %** | Requêtes et consommation observées, valorisées au tarif du modèle réel de chaque réponse |
| Le palier principal assure toute la coordination et l'attente ; les exécutants restent identiques | Environ 5 300,52 | 100 % | Requêtes, tokens et composition du cache inchangés ; coordination économique recalculée au tarif du modèle principal |
| Aucun sous-agent ; toute l'exécution revient à la conversation principale | Environ 5 116,83 | 96,5 % | Communications exclusivement entre agents identifiables retirées, puis travail conservé recalculé au tarif principal |

Avec ces hypothèses, les deux conversations coûtent environ **50,7 %** de moins que la coordination principale, et **49,0 %** de moins que l'exécution par le seul modèle principal. Dans le coût de référence cumulé, les exécutants représentent **80,5 %**, la décision principale **10,8 %** et la coordination économique **8,7 %**.

Le modèle principal de comparaison est GPT-6.1 Sol. Les journaux observés comprennent aussi GPT-6 Luna et un peu de GPT-6.1 Terra. Ces noms sont des conditions de mesure du cas, pas des modèles imposés par le produit. Les tarifs de référence proviennent de la [page officielle OpenAI Pricing](https://learn.chatgpt.com/docs/pricing).

**50,7 % est l'écart obtenu en changeant le tarif de toute la coordination à consommation identique.** Cela couvre la délégation, l'attente, la récupération, la collecte des résultats et les rapports. On ne peut pas écrire que « les retours par lots ont à eux seuls réduit les tokens de 50,7 % ». Aucune des deux alternatives n'a été réexécutée ; les écarts de croissance du contexte, de cache, de durée séquentielle et de qualité de livraison restent inconnus.

### Quel contexte la conversation principale traite-t-elle après le retour d'un sous-agent ?

Compter seulement les outils de délégation et d'attente omet le traitement qui suit la réception des résultats. Nous comptons aussi la première réponse unique mesurée après un retour. Plusieurs retours réunis dans une seule réponse sont comptés une fois ; les blocs de contenu diffusés en streaming ne sont pas comptés à nouveau. Cela mesure le traitement proche d'un retour, sans prouver que la notification seule a causé tout le coût de la réponse.

| Échantillon / rôle | Événements de retour reçus | Premières réponses de réception | Entrée moyenne par réponse, cache compris | Part des lectures de cache |
| :--- | ---: | ---: | ---: | ---: |
| CC : quatre conversations principales | 212 notifications de fin | **207** | Environ 636k tokens | 96,5 % |
| DSH : conversation principale Pro officielle | 112 notifications de fin + 69 transmissions de résultats | **120** | Environ 395k tokens | 99,1 % |
| Codex : conversation de décision principale | 12 rapports de fin de lot | **12** | Environ 272k tokens | 98,2 % |
| Codex : tous les niveaux de coordination économique | 78 retours finaux + 9 messages d'agents | **87** | Environ 165k tokens | 97,8 % |

Les 112 notifications de fin de DSH correspondent à elles seules à **61** premières réponses de réception : le parcours existant regroupe donc déjà les retours. Les transmissions séparées de résultats déclenchent aussi des réponses, pour un total de 120.

Le niveau économique de Codex reçoit encore les retours individuels ; la conversation principale reçoit les rapports de fin de lot. Les requêtes et les coûts des deux niveaux sont tous comptés. Les tâches, durées et modèles du tableau diffèrent : soustraire les nombres de réponses ou les volumes d'entrée ne permet pas de déduire un taux d'économie entre hôtes. Les entrées cumulées comprennent aussi les relectures du cache.

### Pourquoi ne pas étendre pour l'instant les deux conversations de Codex à CC et DSH ?

En ajoutant le traitement des retours à la consommation historique de chaque hôte, puis en recalculant le travail sélectionné au tarif économique, on estime le gain potentiel à vérifier. CC est comparé à **Haiku 5.5**, et DSH à **Flash 4.1-1017 officiel**. Aucun modèle supplémentaire n'a réexécuté les tâches.

| Échantillon historique | Écart de coût total après recalcul des vérifications de coordination + premières réponses de réception au tarif économique | Estimation élargie à tout l'intervalle de traitement après retour |
| :--- | ---: | ---: |
| CC : quatre arbres de conversations, Opus 5.5 → Haiku 5.5 | **Environ 3,8 %** | **Environ 6,6 %** |
| DSH : Pro officiel → Flash officiel | **Au plus 6,8 %** | **Au plus 11,2 %** |
| DSH : petit échantillon Flash officiel → Flash au même tarif | **0 % d'écart de tarif du modèle** | **0 % d'écart de tarif du modèle** |

L'estimation élargie va du retour à la prochaine nouvelle délégation, à la fin du tour ou à une saisie utilisateur indépendante. Elle comprend lecture, intégration et jugement. On n'a mesuré ni la possibilité de transférer tout ce travail au palier économique, ni les coûts de démarrage, de transmission, de cache, de qualité et de maintenance d'un niveau de coordination supplémentaire. Les écarts du tableau ne sont pas des économies réalisées.

Les quatre conversations CC donnent séparément environ **2,9 %, 3,0 %, 2,4 % et 11,1 %** ; 3,8 % est le total pondéré. Dans deux échantillons DSH plus récents avec une conversation principale Claude, le recalcul au tarif Flash de la coordination et des premières réponses de réception donne respectivement environ **0,7 %–1,4 %** et **5,3 %–7,8 %**. Le bénéfice dépend du modèle et de la tâche ; aucun taux unique ne peut être promis à tous les projets.

Ces échantillons appuient une optimisation dédiée à deux conversations pour Codex, tandis que CC et DSH conservent leurs parcours natifs et continuent d'examiner les notifications en double, les réveils évitables, le contenu retourné et l'efficacité du cache. Les notifications natives de fin établissent les capacités d'intégration. L'ajout d'une coordination indépendante exige encore des preuves couvrant ses coûts supplémentaires et la qualité de livraison.

### Mesurer séparément l'attente et les appels au modèle qui la suivent

Le temps bloqué dans un outil d'attente ne produit pas à lui seul de nouvelle entrée du modèle. Un nouvel appel après expiration du délai traite à nouveau le contexte et produit une sortie.

Sur ce journal Codex entier, la conversation principale a produit **244 réponses pour 281,14 credits de référence Standard** ; la coordination économique, **4 430 réponses pour 226,68 credits**. Ces deux coûts sont compris dans le total de 2 610,58 credits. Les 12 réponses désignent seulement les premières réponses après les rapports de fin de lot, pas tous les appels de la conversation principale.

Le niveau économique compte encore **567 réponses mesurées après expiration d'une attente**, traitant environ **91,81 millions de tokens d'entrée**, dont environ **98,9 %** de lectures de cache, pour **26,95 credits de référence**. Ce cas montre l'avantage tarifaire du transfert des reprises fréquentes vers un modèle économique, ainsi qu'une marge pour réduire les reprises après expiration. Il ne permet pas d'affirmer que toute interrogation à vide a disparu.

<details>
<summary><b>Périmètre des échantillons, tarifs et limites des estimations</b></summary>
<br>

**Périmètre.** La fenêtre Codex va du 2026-10-29 à 21:28:39 au 2026-10-31 à 02:46:01, heure de Chine (UTC+8), et couvre deux conversations indépendantes et tous leurs exécutants natifs. Les autres projets, le développement du workflow et cet audit de consommation en sont exclus. L'échantillon CC comprend 4 conversations principales, 210 journaux de sous-agents et 27 767 réponses uniques. DSH comprend 4 arbres de conversations, 115 sessions et 4 672 réponses de différents mois et parcours de modèles. Les journaux privés d'origine ne sont pas publiés avec cette explication.

**Évolution dans le temps.** Les premières 11,6 heures Codex coûtent 932,03 credits de référence, soit une baisse estimée de 58,5 % par rapport à la coordination principale à consommation identique. Les 17,7 heures suivantes coûtent 1 678,55 credits, avec une baisse de 45,1 % ; le cumul atteint 50,7 %. Le seul recalcul du travail de coordination donne un écart de tarif d'environ 92,2 % ; ce n'est pas une baisse du workflow entier.

**Calcul des trois méthodes Codex.** La comparaison avec la coordination principale conserve la fréquence de requêtes, les tokens et la composition du cache observés, et change seulement le tarif des fonctions de coordination économique. La comparaison sans sous-agents retire 1 083 réponses identifiables consacrées exclusivement à la délégation, l'attente, les requêtes d'état et les communications entre agents. Elle conserve les lectures de gouvernance, l'implémentation, l'intégration, la validation et l'attente de processus. Le contexte de démarrage répété qui ne peut pas être isolé de façon fiable reste compté. Le cache, la durée séquentielle et la qualité de l'acceptation indépendante dans une conversation unique longue n'ont pas été mesurés.

**Comptage après retour.** Les notifications CC de commandes en arrière-plan et de sous-agents sont distinguées ; les relations entre messages parents permettent de vérifier les réponses suivantes. Les autres hôtes sont associés selon l'ordre des événements natifs. Les corps complets des requêtes ne permettent pas une réexécution uniforme entre hôtes : la « première réponse mesurée après retour » ne signifie donc pas que chaque token a été causé par ce seul événement. Les candidats de coordination CC comprennent aussi les vérifications programmées, de notification et de surveillance en arrière-plan identifiées séparément. DSH comprend la coordination d'agents identifiable et les premières réponses après notifications de fin ou transmissions de résultats. Les sélections qui se chevauchent ne sont comptées qu'une fois.

**Date des tarifs et unités.** Les tarifs ont été consultés le 2026-10-31. Codex utilise les [credits de référence Standard officiels](https://learn.chatgpt.com/docs/pricing), Claude les [tarifs officiels Global Standard API](https://platform.claude.com/docs/en/about-claude/pricing), et DeepSeek les [tarifs officiels actuels hors pointe](https://api-docs.deepseek.com/quick_start/pricing/). Les factures historiques aux heures de pointe ou jours fériés n'ont pas été reconstituées. Les valeurs de référence tarifaires des API des différents hôtes et les credits Codex ne forment pas une monnaie unique ; elles ne sont pas non plus les factures réelles ou les quotas hebdomadaires d'abonnement.

**Cache et données manquantes.** Selon la [tarification officielle de Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), une requête dont l'entrée complète dépasse 100k tokens utilise le tarif supérieur ; le seuil inclut lectures et écritures du cache. Le palier a été déterminé pour chaque requête. Le tarif de 7 réponses Qwen de l'arbre DSH Pro est inconnu et n'a pas été supposé nul : les pourcentages de l'arbre entier sont donc des bornes supérieures. Certaines écritures du cache Claude dans DSH n'ont pas de durée connue ; un intervalle fondé sur les tarifs de 5 minutes et 1 heure est conservé. Les frais réels de tiers ne sont pas vérifiés. Le raisonnement est inclus dans la sortie et n'est pas facturé deux fois.

**Sens des bornes.** Recalculer tout le travail des conversations principales donne une borne supérieure arithmétique d'environ 15,2 % pour CC avec Haiku et une borne supérieure sur l'arbre entier d'environ 30,7 % pour DSH Pro avec Flash. Cela comprend planification, implémentation, jugements décisifs et acceptation ; tous ces travaux ne sont pas pour autant adaptés à un modèle économique. Les 0 % de Flash au même tarif signifient uniquement qu'il n'y a pas de différence de prix du modèle ; moins de requêtes ou un meilleur contexte peuvent encore apporter un bénéfice.

**Qualité et causalité.** Toutes les comparaisons de coût recalculent statiquement des consommations historiques, sans réexécution contrôlée de la même tâche. Le taux d'économie causal obtenu en réduisant le contexte répété, en changeant de modèle ou en ajoutant une coordination reste inconnu. Le parallélisme et les sous-agents supplémentaires peuvent accélérer l'exécution, mais aussi ajouter démarrage, communication et reprises. L'économie s'évalue avec la consommation de tous les rôles, le délai d'achèvement et la qualité de livraison.

</details>

## Version

Même numéro de version qu'Einzbern, même release. Actuellement {{version}}. Ce README et la table de navigation de SKILL.md sont générés à la release d'Einzbern ; dans ce dépôt, les documents ne sont pas modifiés à la main.

## Ce qu'il contient

- `SKILL.md` : la table de navigation et la routine en trois temps. Les sessions ordinaires ne chargent que ce fichier.
- `references/` : les textes de l'assistant pour l'installation, la restauration, la mise à jour, la migration, la désinstallation et le bilan de santé. Chargés seulement pendant l'installation.

## Documentation complète

Le README et le Wiki d'Einzbern.

## Licence

Apache-2.0
