# 💍 Kanban de Produção: Anéis de Noivado

Quadro estilo Trello para acompanhar a produção da joalheria, conectado ao **Shopify** (cada pedido de anel de noivado vira um card automaticamente) e ao **Google Planilhas**.

## O que a ferramenta faz

| Recurso | Como funciona |
|---|---|
| **Colunas ilimitadas** | Crie, renomeie, reordene (arrastando pelo título), escolha a **cor** e **minimize** colunas (os cards continuam dentro, só a coluna fica estreita). Cada usuário minimiza do seu jeito. |
| **Calendário** | Botão *Calendário* no topo mostra os cards em visão de mês ou semana, pelo prazo de entrega, pela data de criação ou por qualquer campo de data. Em *Exibir*, cada usuário escolhe o que aparece em cada card (título, horário, etapa, etiquetas, responsáveis, capa e qualquer campo personalizado) e qual cor usar. Arraste um card para outro dia para mudar a data, ou da lista *Sem prazo* para um dia para definir. |
| **Rolagem infinita** | O quadro rola na horizontal sem limite (barra, roda do mouse ou arrastando o fundo, como no Trello). Cada coluna carrega 40 cards e busca mais conforme você rola, então aguenta milhares de pedidos. |
| **Cards personalizáveis** | Campos criados por você: texto curto, texto longo, número, valor (R$), data, data e hora, sim/não, lista de opções (com cores), múltipla escolha, link, e‑mail e telefone (com botão de WhatsApp). Você escolhe quais aparecem no card do quadro. |
| **Imagens e capa** | Anexe imagens arrastando, escolhendo o arquivo ou colando (Ctrl+V). A primeira imagem vira capa automaticamente; dá para trocar ou tirar a capa a qualquer momento. Também aceita PDF, STL, 3DM etc. |
| **Cor do card e etiquetas** | Cada card pode ter cor de fundo (paleta ou cor livre) e etiquetas coloridas criadas por você. |
| **Shopify** | Webhook "Criação de pedido": pedidos com anel de noivado (por palavra no nome do produto, ID do produto ou tag) viram cards na coluna escolhida, com cliente, tamanho do aro, gravação etc. já preenchidos nos seus campos. Pedidos repetidos não são duplicados. |
| **Correios** | Para clientes com contrato: ao chegar um pedido, consulta o prazo dos Correios até o CEP do cliente e define o prazo do card como *entrega prometida − prazo dos Correios − folga* (dias úteis, sem feriados nacionais). O card mostra "Postar até" e tem um botão para recalcular. |
| **Google Planilhas** | Você escolhe quais campos do card viram colunas da planilha. Cada card é uma linha, atualizada automaticamente a cada mudança. Há um botão para reenviar tudo. |
| **Tempo de produção** | Defina a coluna onde o cronômetro começa e a coluna final. Cada card mostra há quanto tempo está em produção e, ao chegar na última coluna, o tempo total. O relatório "⏱ Produção" mostra média, mediana, mais rápido/lento, % entregue no prazo e tempo médio em cada etapa. |
| **Vários usuários + histórico** | Perfis: administrador, editor e somente leitura. Tudo o que cada pessoa faz (mover, editar campo, anexar, mudar cor…) fica registrado com nome e horário, no card e no histórico geral. As telas se atualizam sozinhas quando outra pessoa mexe. |
| **Avisos de prazo** | Avisa X dias antes (ex.: 3, 1 e no dia) e quando vence: no sininho do sistema, como notificação do navegador, por e‑mail e/ou webhook (Slack, Discord, Zapier/Make → WhatsApp). Também tem um botão para mandar o aviso na hora. |

## Instalação rápida

Requisito: **Node.js 22.13 ou mais novo**.

```bash
cd kanban-producao
npm install
npm start
```

Abra http://localhost:3000. Na primeira vez você cria a conta de administrador, e o sistema já monta um quadro com as etapas de produção (Novos pedidos → Design/CAD → Fundição → Cravação → Polimento → Controle de qualidade → Pronto para envio), além de etiquetas e campos de exemplo. Tudo pode ser alterado.

Os dados ficam na pasta `data/` (banco SQLite + anexos). **Faça backup dessa pasta.**

### Variáveis de ambiente (opcionais)

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `DATA_DIR` | `./data` | Onde ficam o banco e os anexos |
| `TZ` | `America/Sao_Paulo` | Fuso usado nas datas da planilha e dos avisos |
| `PUBLIC_URL` | (vazio) | Endereço público, usado nos links dos avisos |
| `NOTIFY_INTERVAL_MINUTES` | `10` | De quanto em quanto tempo os prazos são verificados |
| `MAX_UPLOAD_MB` | `20` | Tamanho máximo de cada anexo |

## Colocando no ar (necessário para o Shopify)

O Shopify precisa enviar os pedidos para um endereço público com **https**. Opções simples:

- **Render (mais fácil):** crie uma conta em [render.com](https://render.com), clique em *New → Blueprint* e escolha este repositório. O arquivo `render.yaml` na raiz já configura tudo (servidor, disco de 1 GB para banco e anexos, fuso horário). O Render gera um endereço `https://….onrender.com`; use-o no Shopify e em Configurações → Notificações. O disco persistente exige o plano pago *Starter* (sem disco, os dados se perdem a cada atualização).

- **Docker** (VPS, Railway, Render, Fly.io…): `docker build -t kanban . && docker run -p 3000:3000 -v kanban-data:/data kanban`. Use um disco/volume persistente em `/data`.
- **VPS com Node**: `npm install --omit=dev && npm start` atrás de um Nginx/Caddy com HTTPS.

## Conectando o Shopify

> Desde **1º de janeiro de 2026** a Shopify não permite mais criar "apps personalizados" dentro do admin (os que davam um token `shpat_`). O app agora é criado no **Dev Dashboard** e a conexão usa **Client ID + Client secret**: o sistema troca essas credenciais por um token que vale 24 horas e renova sozinho.

Em **⚙ Configurações → Shopify** (o passo a passo também está na tela):

1. No admin da Shopify, vá em **Configurações → Apps → Desenvolver apps** e abra o **Dev Dashboard** (ou acesse [dev.shopify.com](https://dev.shopify.com) com a mesma conta). Clique em **Criar app**, escolha começar pelo Dev Dashboard e dê um nome.
2. Na aba **Versões**, crie uma versão: em *App URL* coloque o endereço do sistema (ex.: `https://kanban-producao.onrender.com`); em *URLs de redirecionamento* adicione `https://kanban-producao.onrender.com/api/shopify/oauth/callback`; use a versão de webhooks **2026-10** e marque os escopos **read_orders**, **read_products** e **read_customers**. Clique em **Lançar (Release)**.
3. Na visão geral do app, clique em **Instalar app** e escolha a sua loja.
4. Nas configurações do app, copie o **Client ID** e o **Client secret** e cole no sistema, junto com o domínio da loja (pode colar o link do admin `admin.shopify.com/store/...`, que o sistema converte para `....myshopify.com`).
5. Clique em **Conectar com a Shopify**, aprove o acesso na tela da Shopify e você volta conectado. Depois clique em **Testar conexão** e **Registrar webhook**. A partir daí, cada pedido novo chega sozinho.

   *Por que esse botão?* A troca direta de Client ID/secret por acesso (client credentials) só funciona quando a loja está na **mesma organização** do app no Dev Dashboard; caso contrário a Shopify responde `shop_not_permitted`. A autorização pelo botão funciona em qualquer caso e o acesso é renovado automaticamente.
6. Defina as **palavras‑chave** (padrão: "anel de noivado, noivado, solitário"), a **coluna de entrada** e **qual dado do pedido preenche cada campo**. Marque **Integração ativa** e salve.

Se o nome, o endereço ou o e-mail do cliente chegarem vazios, peça no Dev Dashboard o acesso a **dados protegidos de clientes**.

Ainda funcionam, em "Outras formas de conexão": o token `shpat_` de apps antigos criados no admin antes de 2026 e o webhook criado à mão em Configurações → Notificações → Webhooks (com a chave mostrada lá).

## Conectando os Correios (prazo automático)

Em **⚙ Configurações → Correios**:

1. Preencha o **usuário** do Meu Correios, o **código de acesso às APIs** (gerado em [cws.correios.com.br](https://cws.correios.com.br) → "Gestão de acesso a API's"; não é a senha do site) e o **cartão de postagem**. O contrato precisa ter o serviço **38210 – API PRAZOS**.
2. Informe o **CEP de origem**, o **serviço** (SEDEX, PAC…), a **folga** em dias úteis e o horário limite de postagem.
3. Diga **onde está a data de entrega prometida** no pedido: numa personalização do produto, num atributo do pedido (informação do carrinho) ou "X dias depois do pedido". Informe o nome exato do campo (ex.: "Data de entrega").
4. Use **Consultar prazo** para testar com um CEP e marque **Integração ativa**.

Se a data prometida não for encontrada ou os Correios não responderem, o card usa o prazo padrão da integração do Shopify e a descrição explica o motivo. Dentro de cada card, a seção **Envio (Correios)** permite corrigir o CEP ou a data e recalcular.

## Conectando o Google Planilhas

Em **⚙ Configurações → Google Planilhas** (o passo a passo também está na tela):

1. No [Google Cloud Console](https://console.cloud.google.com), ative a **Google Sheets API** e crie uma **conta de serviço** com uma chave **JSON**.
2. Envie o arquivo JSON no sistema e cole o link da planilha.
3. **Compartilhe a planilha** com o e‑mail da conta de serviço como **Editor**.
4. Escolha e ordene os campos que vão para a planilha, salve e clique em *Enviar todos os cards agora*.

A coluna A sempre tem o ID do card (é como o sistema encontra a linha certa), por isso não a edite.

## Avisos de prazo

Em **⚙ Configurações → Notificações**: dias de antecedência, aviso de vencido e canais. Os avisos vão para os **responsáveis** do card (ou para todos, se não houver responsável). Cards que já chegaram na coluna final não geram aviso. Para e‑mail, preencha o SMTP (Gmail: `smtp.gmail.com`, porta 465 com SSL e uma *senha de app*). Para WhatsApp, use o webhook com Zapier/Make.

## Testes

```bash
npm test
```

## Estrutura

```
server/
  index.js          servidor HTTP + webhook do Shopify
  routes.js         API (quadros, colunas, cards, campos, anexos, usuários, integrações)
  cards.js          regras dos cards e registro de histórico
  cycle.js          cálculo do tempo de produção
  shopify.js        filtro de pedidos e criação dos cards
  sheets.js         sincronização com Google Planilhas
  notifications.js  avisos de prazo
  events.js         atualização em tempo real
  db.js / auth.js   banco SQLite e login
public/             interface (HTML/CSS/JS, sem etapa de build)
test/               testes automatizados
```
