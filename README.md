# Iron Office — canal do Claude Code

Liga o dashboard do **Iron Office** (https://ironoffice.app; o endereço antigo https://iron-office.vercel.app continua respondendo) à sessão do Claude Code na sua máquina:

- você escreve no **chat do site** (`/chat`) e o Iron responde ali mesmo;
- o **feed** e o **mapa 3D** do dashboard mostram as ferramentas e os agentes trabalhando enquanto ele responde.

O motor é o seu Claude Code (sua assinatura, seus arquivos). O site é só a janela.

## Instalar e ligar

1. Faça o onboarding do Iron Office até o **passo 2 (Ligar o Iron)** (gera a chave e salva em `~/.claude/iron-office-api-key`).
2. No terminal:

   ```bash
   npx iron-edge office
   ```

   Esse comando adiciona este marketplace, instala o plugin `iron-office` e abre o Claude Code com o canal ligado.
3. O Claude Code mostra um **aviso de tela cheia** (canais ainda são *research preview*). Aceite.
4. Abra https://ironoffice.app/chat. Em até 1 minuto aparece **"Iron online"**.

**Deixe essa aba do terminal aberta.** É ela que faz o Iron responder no site.

## Instalação manual

```bash
claude plugin marketplace add filipecoff21-code/iron-office-channel
claude plugin install iron-office@iron-office-channel --scope user
IRON_OFFICE_CHANNEL=1 claude --dangerously-load-development-channels plugin:iron-office@iron-office-channel
```

Prefira `npx iron-edge office`, que faz isso tudo e confere cada passo.

## Como funciona

| Peça | O que faz |
|---|---|
| `dist/server.mjs` | Servidor MCP (canal). Puxa as mensagens do site (`GET /api/chat/pull`, a cada 2 s com o chat aberto, 15 s fechado), injeta na sessão, confirma a entrega (`POST /api/chat/ack`) e expõe as ferramentas `reply` (resposta no chat) e `deliver` (salva a entrega em `POST /api/deliverables`, com o cartão de ação opcional `card` que o chat mostra, e devolve o link `/deliverables?id=`). Marca presença a cada 30 s (desde a 0.4.0 com os NOMES dos servidores MCP de `~/.claude.json` (usuário e pasta, menos os desligados no /mcp) e do `.mcp.json` aprovado, nunca os valores: é assim que o site mostra Meta Ads "instalado no terminal"; arquivo quebrado = presença sem o campo, o site mantém a lista) e, ao fechar (inclusive fechando a janela do terminal), avisa o site que o Iron saiu (o escritório anoitece). |
| ferramentas da loja | `shop_status` (as lojas do aluno: `GET /api/shopify/graphql?stores=1` → `{ stores, active }`, desde a 0.7.0) e `shop_query` (query ou mutation GraphQL da Admin API, `POST /api/shopify/graphql`; resposta acima de 60 kB vem cortada; o site recusa escrita fora da lista: cliente, pagamento e o resto do pedido). Funcionam em **qualquer** sessão, não só no canal: é por elas que o agente `iron-shopify` fala com a loja, sem ler a chave nem fazer `curl` (desde a 0.3.4). |
| ficha da loja (0.7.2) | ferramenta `store_update` (só na sessão do canal): grava no site o caminho da ficha no cofre (`ficha_path`, só relativo, sem `..`, `/`, `~` nem letra de unidade) e um resumo de até 600 caracteres, passando pelo filtro de segredos; `POST /api/stores/<id>/ficha`. A skill `loja` do pacote `iron-edge` 2.8.0 é quem chama. Mensagem com `ficha: ainda sem ficha` e pedido sobre a loja: o Iron oferece montar a ficha em 1 linha e espera o sim. Aviso do site `→ recusada pelo aluno` ou `→ venceu sem confirmação`: 1 linha, sem propor a mesma ação de novo. |
| trilha e perguntas (0.8.0) | três ferramentas, só na sessão do canal. `ask` faz UMA pergunta no chat com até 6 opções em botão (texto até 300, opção até 60), campo livre (`free`) e "Pular" (`skip`), e o clique volta como mensagem normal. `trail_status` lê a trilha da loja (`GET /api/stores/<id>/trail`: etapas, estado e a próxima). `trail_update` grava uma etapa (`POST /api/stores/<id>/trail`): `provada` exige `proof` com o que foi medido, `pulada` exige o motivo, e a prova passa pelo filtro de segredo, e-mail e telefone, com até 2000 caracteres (acima disso é recusada, nunca cortada). O prefixo da mensagem ganha `trilha: N feitas` e, no caminho sem loja, `caminho: criar a loja`. Instrução: trilha pela skill `trilha` do `iron-edge` 2.9.0, uma pergunta por vez, e na ação de pedido "confirme no cartão acima" em 1 linha. |
| velocidade, fuso e Meta (0.8.1) | ferramenta `store_speed` `{ project_id }` (qualquer sessão): `GET /api/stores/<id>/speed`, o site mede a vitrine no PageSpeed com a chave do Google que fica no servidor e devolve `{ url, score, top3 }`; espera até 70 s; "sem chave", "limite" e "loja sem Shopify" viram frase em português. `shop_status` passa a trazer `timezone` (fuso IANA da loja, pode vir null) pra hora sair no fuso dela. Na prova da trilha, id de 15 a 20 dígitos em chave `*_id` (conta e pixel da Meta) passa inteiro; o resto continua no filtro de telefone. Instrução: `/mcp` ou Meta ausente na sessão = os 3 passos (no terminal `/mcp` → `meta-ads` → entrar com o Facebook → fechar e abrir o `ironoffice`), nunca "não funciona aqui". Skills da trilha no `iron-edge` 2.10.0. |
| retrato dos anúncios (0.9.0) | ferramenta `ads_status` `{ project_id, snapshot }` (só na sessão do canal, `ironoffice`): a skill `anuncios` do `iron-edge` 2.12.0 mede a conta da Meta (7 dias) e grava o retrato no site por `POST /api/stores/<id>/ads` (números, campanhas ≤ 10, peças ≤ 5, alertas ≤ 10, rampa). Todo texto passa pelo filtro: e-mail, telefone e `@perfil` viram `[removido]` (id da Meta e número de conta ficam: o telefone só casa sozinho, 9 a 12 dígitos); `account_id` e datas não passam pelo filtro de telefone. Retrato acima de 8 kB é recusado no plugin. Nunca token nem login: o site só guarda o que o Iron mediu. Instrução: `anúncios: atualizar` (botão da aba Anúncios) ou 'como estão meus anúncios' = skill `anuncios`. |
| grupos por campanha (0.9.1) | a descrição do `ads_status` pede `adsets_active` e `adsets_total` em cada campanha (iron-edge 2.13.0 conta pelo `campaign_id`): o site mostra "parada: nenhum grupo no ar" (rótulo da 0.27.0 do site) na campanha no ar sem grupo no ar. |
| funil e precificação (0.9.2) | `ads_status` grava o retrato **v2** (iron-edge 2.14.0): 12 números do funil na conta e em cada campanha, 5 na peça, `result_label` por campanha e `product_handle`, todos planos; `null` = a Meta não mandou. A resposta traz `pricing` (frase do site: CPA máximo × real) e `reading`. O filtro aceita até 40 chaves por objeto (o v2 tem 29 no topo). |
| imagens (0.10.0; link da aba 0.10.1) | ferramenta `image_generate` `{ project_id, prompt, request_text?, destination, label?, provider?, n?, product_handle?, dry_run? }` (só na sessão do canal): o **site** gera com a chave do provedor do aluno (OpenAI ou fal), cifrada no servidor e que nunca vem pra cá, e guarda na aba Imagens. O prompt passa pelo filtro (e-mail, telefone, chave). A resposta volta só com `{ ok, id, url (link da aba Imagens, sem token), width, height, provider, cost_usd, cost_kind, cap_left_usd }` (ou `reason` + `error`). A descrição manda pedir o custo com `dry_run` e o sim pelo `ask` antes de gerar. Skill `imagens` do iron-edge 2.15.0. |
| imagens com a foto real e na Shopify (0.11.0) | `image_generate` ganha `reference { product_handle, variant_id?, media_index? }`: o **site** escolhe e baixa a foto do produto na Shopify da loja (só do CDN da Shopify; nunca URL vinda daqui) e gera a partir dela (só OpenAI); o `quote` cobre a foto. Ferramenta nova `image_to_shopify { image_id, project_id, product_handle, variant_ids?, alt?, remove? }`: o site põe a imagem na página do produto da mesma loja (ou tira com `remove: true`); a descrição manda perguntar pelo `ask` antes de subir. `alt` passa pelo filtro. Skill `imagens` do iron-edge 2.16.0. |
| páginas da loja (0.12.0) | `deliver` ganha `url` (a página auditada ou entregue; vai como `page_url`, passa pelo filtro e, inválida, não vai: a entrega vai). Ferramenta nova `page_save { project_id, title, kind: landing|clone|shopify|outra, url?, local_path? }`: registra na aba Páginas do site a página que o Iron fez; com `url` o **site** abre a página (com as travas contra endereço interno) e mostra se está no ar; só com `local_path` fica rascunho. Mesma URL = atualiza. As instruções do canal mandam passar a `url` na auditoria e chamar `page_save` ao terminar uma página, nunca publicando sozinho. |
| formulário no chat (0.13.0) | `ask` ganha `fields` (1 a 12 campos `{ id, label, placeholder?, kind: text|number|money|yesno }`, sem `options`): o site mostra um formulário com "Pular este" por campo e um "Enviar respostas"; a resposta volta como UMA mensagem do aluno com "rótulo: valor" por linha. As instruções do canal mandam: dados que o aluno sabe = formulário, nunca "veja na entrega"; página de vendas na lógica de uma referência pergunta "reaproveitar frases?" (e a voz, sem `## Voz` na ficha) ANTES de chamar o iron-clone, e a v2 sai depois do último formulário. |
| ação de pedido (0.7.1) | cancelar pedido, nota e etiquetas: o `shop_query` manda a mutation com `project_id`, o site responde **202** (pendente, 10 min) e o plugin devolve "Ação pendente de confirmação no site… NÃO repita a mutation". O aluno confirma no cartão do chat; o site executa e manda uma mensagem `meta.system = "action"`, que entra na sessão com `user="sistema"` e sem prefixo de loja: o Iron responde em 1 linha e não executa nada. Estorno, pagamento, cliente e endereço continuam recusados (403). |
| loja ativa (0.7.0) | a mensagem do site chega com a 1ª linha `[loja: <nome> · <tipo> · id: <uuid> · ficha: <caminho ou "ainda sem ficha">]` (o `id` desde a 0.7.1) (nome e caminho passam pelo filtro de segredos). O plugin guarda a loja da última mensagem e `reply`, `deliver` e as leituras do `shop_query` vão pra ela quando o modelo não passa `project_id`. **Mutation nunca vai pela última mensagem** (o aluno pode ter trocado de loja no meio da tarefa): sem `project_id` explícito, o site decide (1 loja conectada = ela; 2+ = 409). Mensagem sem loja (de antes da onda 26a) vai sem prefixo e zera a loja. Com 2+ lojas conectadas e nenhuma escolhida, o site responde 409 e o `shop_query` devolve "diga qual loja" com a lista. |
| `hooks/post-event.mjs` | Hooks `PostToolUse`, `SubagentStart`, `SubagentStop` e `Stop` mandam a atividade pro `POST /api/events` (feed e mapa 3D). Só na sessão do canal (`IRON_OFFICE_CHANNEL=1`): `claude` aberto em outra pasta não manda nada. Ferramenta usada dentro de um subagente leva o id e o tipo do agente que a usou. |

- **Só a sessão aberta com o canal recebe o chat.** O plugin fica ligado em toda sessão do Claude Code (por causa dos hooks), mas uma aba comum não puxa mensagem nenhuma.
- **Entrega garantida:** a mensagem só vira "entregue" depois que a sessão recebeu. Se a internet cair no meio, ela volta pra fila em 60 s.
- **Mensagem velha não é executada:** o que ficou mais de 15 minutos esperando (terminal fechado) expira, e o chat avisa pra mandar de novo.
- Só **uma** sessão por máquina recebe as mensagens (lock em `~/.iron/office.lock`). As outras ficam passivas e assumem quando a ativa fecha.
- Sem chave: sobe em modo degradado e só explica como resolver.
- Chave inválida: avisa uma vez no terminal e tenta de novo depois de 5 minutos.
- Pra testar contra um servidor local: `IRON_OFFICE_URL=http://localhost:3000`.

## Fechar o canal

Ctrl+C duas vezes ou `/exit`: o escritório anoitece em 1 a 2 segundos. Fechar a janela do Terminal também anoitece na hora.

No **Warp**, fechar a aba pelo X demora cerca de 1 minuto: o Warp guarda a aba fechada pra poder reabrir, e nesse tempo o canal ainda está vivo. Feche com Ctrl+C antes do X, ou desligue a reabertura de abas fechadas nas configurações do Warp.

## O que sai da sua máquina

Com a chave do Iron Office salva, **só a sessão aberta pelo `npx iron-edge office`** (ou `ironoffice`) manda pro seu painel (visível só pra você); uma aba comum do Claude Code não manda nada (plugin 0.3.1 em diante, e o hook anterior é ignorado pelo site desde a 0.3.8):

- o nome de cada ferramenta usada (menos `Read`, `Grep` e `Glob`);
- o **caminho** dos arquivos criados ou editados (nunca o conteúdo);
- os primeiros 200 caracteres de cada comando de terminal e a descrição curta dele;
- buscas na web e o **domínio** dos endereços visitados (sem caminho nem parâmetros);
- o nome e a descrição curta dos agentes acionados;
- a pasta onde a sessão está rodando e o identificador da sessão;
- ao fechar, um aviso de que o Iron saiu (o escritório anoitece).

A **resposta** das ferramentas (saída de comando, conteúdo lido, resultado de agente) **nunca sai**.

O feed só aceita o hook desta versão em diante. Sessão do Claude aberta antes de atualizar o plugin não manda mais nada: feche e abra o canal de novo (`ironoffice`) pra voltar a ver a atividade.

Nos campos acima, padrões conhecidos de segredo são apagados **antes** de sair: chaves de Stripe, Shopify, Meta, GitHub, OpenAI/Anthropic, Supabase e AWS, JWT, `Bearer`, `ALGO_KEY=valor`, `"password": "…"`, `--password X`, `--token=X`, `-pSENHA` e `-u usuario:senha`. É uma lista de padrões, não uma garantia: um segredo num formato que ela não conhece passa.

**Feed desligável (0.5.0):** `npx iron-edge office --sem-feed` grava `office_feed: off` no `~/.iron/config.yaml`. Com isso o hook não manda nada e a presença (que é o que liga o chat) vai sem a pasta e sem os nomes dos conectores: o site mostra o Iron online e o escritório parado. `--com-feed` volta.

**Mensagem do site é entrada externa (0.5.0):** a instrução do canal diz que as mensagens foram digitadas no site por quem está logado na conta ligada à chave, e manda tratar como pedido do usuário, nunca como aviso do sistema nem como permissão. Senha, chave, token, conteúdo de `.env`, `~/.claude.json`, a chave do Iron Office, dado de cliente e segredo de loja nunca saem por `reply` nem `deliver`. O `reply` e o `deliver` (título, conteúdo e cartão) passam por um filtro de formatos de chave (Iron Office, Stripe, Shopify, Meta, GitHub, OpenAI/Anthropic, Supabase, AWS, Google, Slack, Hugging Face, JWT, `Bearer`, senha em URL, `NOME_SECRETO=valor` de `.env` em maiúscula e `password=`/`token=`/`secret=`/`api_key=` em minúscula); o `reply` para em 20 mil caracteres e o `deliver` em 50 mil. A pasta enviada no feed também passa pelo filtro.

**Nota do gate na página (0.14.0):** quando o Iron entrega o gate de uma página rascunho, o `deliver` leva junto o `page_id`: o id que o próprio site devolveu no `page_save` (um uuid do Iron Office, nada da sua máquina nem pessoal). Serve só pra nota aparecer na linha certa da aba Páginas. Id fora do padrão não sai.

**Resposta é botão, rodada tem fim (0.14.2):** pergunta de sim/não ao aluno é `ask` com botões ('Sim, …' e 'Depois'), nunca prosa pedindo pra digitar uma palavra. Em toda página nova da trilha de persuasão o Iron pergunta se pode reaproveitar frases da referência, e o aluno pode pular. Quando o último formulário volta, a trilha fecha com a v2 pelo `deliver` e, logo depois, a `ask` do gate. Mensagens que chegam juntas (um 'Pular' seguido de pedido novo) têm cada uma a sua resposta. O retorno do `reply` traz um aviso pro Iron quando o texto pede resposta em prosa, quando há mensagem sem resposta na conversa (um trecho de até 80 caracteres, com chave apagada) ou quando o formulário voltou sem a v2; o aviso nunca segura a mensagem. Esse aviso e o trecho ficam só na sessão do seu computador (vão pro Iron, não pro site) e somem em 30 minutos ou quando o Iron fecha. O plugin é publicado por tag no GitHub (sem npm): atualizar é o que o `ironoffice` faz ao abrir.

**Instruções cabem no corte (0.15.0):** o Claude Code só entrega ao Iron os primeiros 4 096 caracteres das instruções de um plugin. O bloco deste canal tem menos de 3 900, e um teste trava isso: regra nova entra só tirando outra. O resto das regras vive na skill `office-fluxos` (dentro do plugin, sem nada pessoal) e nas descrições das ferramentas. Quando o pedido é uma página na lógica de uma referência, o plugin põe uma linha `[iron-office: …]` no começo da mensagem, lembrando o Iron de perguntar antes se pode reaproveitar frases. O `page_save` e o `deliver` devolvem o passo seguinte (formulário ou a pergunta do gate). Lacuna do fornecedor também vira formulário, e o que você pular aparece como "dado pendente" na página. Nada disso sai da sua máquina.

**Primeira conversa (0.18.0):** num cofre novo, a 1ª mensagem do chat leva uma linha que carrega a skill `entrevista`: até 5 perguntas opcionais, guardadas em `00 Sobre mim.md` no cofre. Nas sessões seguintes, a linha manda ler esse arquivo. O bloco de instruções não mudou.

**Período Hoje (0.19.0):** o botão "Atualizar agora" da aba Anúncios pode pedir `anúncios: atualizar · hoje`; o lembrete do botão vale pra ele também. `ads_by_product` aceita `days: 1` (só o dia de hoje) e o `ads_status` grava `window_days: 1`. O site guarda o último retrato de cada período. O bloco de instruções não mudou.

**Outro Iron aberto (0.20.0, atraso na 0.21.0):** a sessão que nasce com outro Iron vivo no computador fica em espera e avisa no terminal (aviso `system`, uma vez, 10 s depois do handshake; se assumir antes, só sai o aviso de que assumiu); quando o outro fecha, assume e avisa de novo. `IRON_OFFICE_RETAKE_MS` e `IRON_OFFICE_WAIT_NOTICE_MS` (200 ms a 15 s) só encurtam as esperas no teste.

**Porteiro de instalação (0.22.0):** na sessão do `ironoffice`, antes de o Iron instalar algo que não é da casa (pacote npm ou Python, programa do Homebrew, repositório, script da internet, conector, plugin, extensão, ou arquivo que vira skill/agente/conector, escrito por Write/Edit ou pelo terminal), o gancho `hooks/porteiro.mjs` barra o comando e o Iron pergunta no chat: **Estudar antes (recomendado)** · **Instalar mesmo assim** · **Não instalar**. Quem libera é o clique do aluno, gravado por este plugin em `~/.iron/porteiro/liberados.json` por 30 minutos; a pergunta só sai no texto do modelo, com o item batendo com o código do botão, e o Iron não pode mexer na pasta do porteiro (`~/.iron/porteiro`, onde também fica o modo). O que é da casa passa sem pergunta (lista em `hooks/casa.json`), e `npm install` sem nome de pacote também (só restaura o projeto), assim como o `npx` de uma ferramenta que o projeto já tem. O registro fica em `~/.iron/porteiro/registro.jsonl`, nada sai da máquina. Escrever `todas` no arquivo `~/.iron/porteiro/modo` liga em toda sessão do Claude Code; `off` desliga (é o aluno quem escreve, no terminal dele; o Iron é barrado). O `~/.iron/config.yaml` fica livre pra loja e pro cofre.
**Como ele lê (Revisão 1):** detectar é separado de nomear, e detectar só pode ganhar com texto a mais. O comando é normalizado (sem barra invertida, sem aspas, `$(` e parênteses viram espaço, caminho do binário vira o nome) e o porteiro procura PALAVRAS: um instalador (`npm`, `pip`, `brew`, `git`, `claude`…) e, depois dele no mesmo trecho, o verbo (`install`, `add`, `clone`, `mcp add`…), ou um pipe pra shell/`iex`/`node`/`python`. Por isso ele pergunta a mais quando um texto só cita uma instalação (uma mensagem de commit, um README gravado pelo terminal). "Da casa" só passa calado quando o comando é literal (sem `$`, crase, barra invertida ou `eval`) e todos os nomes estão na casa.
**Limites:** é um freio pra um Iron que coopera e pra injeção simples, não pra quem quer enganar de propósito: instalador montado em pedaços (variável, `$'\x6e'`, base64 decodificado e rodado sem pipe), script gravado ou baixado num comando e rodado em outro, binário copiado com outro nome, código Python/Node que instala por dentro, separador de shell entre aspas no meio dos pacotes, e o caminho da pasta do porteiro montado em variável ou curinga (`~/.ir?n/p*`); citar `.iron/porteiro`, `liberados.json`, `porteiro/modo`, ou `.iron` junto com a palavra porteiro, barra em qualquer forma, e com a pasta atual dentro de `~/.iron` a palavra porteiro já barra. Só vê o que o Iron roda (o que você digita no seu terminal passa direto). Não cobre winget, choco, scoop, apt, cargo, go install, gem nem Install-Module. Baixar num arquivo e rodar no mesmo comando barra (`curl -o`/`-O`/`--output`, `wget -O`, `-OutFile` ou `DownloadFile`, junto de um shell, `source`, `node`, `python`, `iex` ou `./x` em qualquer parte do comando), e por isso `curl -o dados.json … && node x.js` também pergunta. Desde a 0.23.0 também barra `wget` sem `-O`, `Start-Process`, `start`, `saps` e o `&` do PowerShell depois de baixar, o arquivo gravado citado de novo por qualquer caminho (por isso `curl -o foto.jpg … && cp foto.jpg x` pergunta) e baixar pra uma variável num trecho e dar `iex`, `eval` ou `bash -c "$x"` em outro. Fica de fora o que monta o comando por dentro (`[scriptblock]::Create($s)`, `powershell -Command $c`). Na corrida de três aberturas ao mesmo tempo com trava órfã, ainda há uma janela de microssegundos em que dois Irons podem ficar ativos. Continuam passando `curl … > arquivo` e interpretadores fora dessa lista (`perl`, `ruby`). O `npm install` sem nome passa de propósito: o Iron pode editar o `package.json` e rodar `npm install` seco sem pergunta, e o porteiro não vê esse pacote entrar (é o preço de não parar clone-site, lp-cinematico e hyperframes). `Write` em `~/.claude/CLAUDE.md` passa: é texto de instrução, e gancho só vale pelo `settings.json`, que barra. Se o próprio porteiro der erro, ele deixa passar (nunca trava a sessão). Estudar reduz o risco, não garante.

**Botão Atualizar (0.17.1):** depois do pedido `anúncios: atualizar`, o retorno do `reply` lembra de gravar pelo `ads_status`, até gravar; o bloco de instruções não mudou.

**Anúncios por produto (0.17.0):** a ferramenta `ads_by_product` manda as peças medidas pro site, que cruza com as visitas e os pedidos da Shopify e devolve `products`, `outside`, `pending` e `ad_handles`; o Iron copia pro `ads_status` sem recalcular. Id de peça e de campanha não passam pelo filtro de telefone; só o nome da campanha passa. O bloco de instruções não mudou.

**Período dos anúncios (0.16.1):** a descrição do `ads_status` aceita `window_days` 7, 15 ou 30 (a janela que o aluno escolheu na aba Anúncios) e o alerta `recusada_antiga` (recusada em campanha parada e sem gasto, que o site mostra numa linha cinza). O bloco de instruções não mudou.

**Minerar (0.16.0):** "o que está vendendo em <país>", "minerar" e "produto vencedor" entram no gatilho do bloco de instruções e levam o Iron à skill `minerar` (vem no pacote `iron-edge`). A ferramenta `ask` aceita `link: "dropkiller"`: o site desenha, embaixo das opções, o botão de assinar o DropKiller. O campo leva só a chave, nunca uma URL: o link mora no site, não no plugin. Chave desconhecida, ou `link` num formulário, é recusada.

Política completa, em português de gente: ironoffice.app/termos.

**Pra desligar:** `claude plugin disable iron-office@iron-office-channel` (ou `uninstall`). Apagar `~/.claude/iron-office-api-key` também corta todo envio.

## Licença e alvo protegido

O plugin não filtra pedido nenhum. A regra que impede o Iron do aluno de clonar, auditar ou copiar o Iron Office ("Alvo protegido") vem do pacote `iron-edge` (agentes e skills, desde a 2.5.1), e o site recusa na hora os atalhos "usa o iron-auditor:"/"usa o iron-clone:" que apontam pro próprio Office. O pacote `iron-edge` e o site seguem a Licença de Uso Pessoal Iron Edge (ironoffice.app/termos); este plugin tem a própria licença, no arquivo `LICENSE` deste repositório.

## Desenvolvimento

```bash
npm install
npm run build   # gera dist/server.mjs (commitado, sem dependência de runtime)
npm test        # build + testes sem rede (servidor falso, HOME temporário)
```

Requer Node 18+.

