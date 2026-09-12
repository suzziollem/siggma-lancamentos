# SIGGMA — Lançamentos diários

Aplicativo web da PanDog para preparar lotes financeiros antes do lançamento na tela 110 do SIGGMA.

## Como usar

1. Abra o aplicativo.
2. Em **Padrões**, cadastre uma opção por combinação de fornecedor/cliente, tabela do título e centro de custo.
3. Em **Lançamentos do dia**, selecione o padrão e informe valor, data e situação.
4. Clique em **Copiar lote para enviar ao ChatGPT** e cole o conteúdo na conversa do projeto SIGGMA.
5. Depois que os lançamentos forem conferidos e gravados no SIGGMA, marque o lote como concluído.

Os dados ficam no armazenamento local do navegador. Use **Baixar cópia de segurança** regularmente. O programa não guarda usuário ou senha do SIGGMA.

## Regras implementadas

- A tabela contábil do título vem do padrão escolhido.
- Para contas a pagar já pagas, a liquidação usa a tabela 22.
- O título é salvo antes da liquidação.
- Banco e forma de pagamento ficam em branco quando opcionais.
- Itens pendentes não recebem baixa.
- O programa alerta itens idênticos no lote atual ou no histórico local.

## Publicação no GitHub Pages

O projeto é estático e não exige servidor. Publique o conteúdo da branch principal pelo GitHub Pages. Por conter apenas código e nenhum lançamento financeiro, o repositório pode ser privado; confirme se o seu plano do GitHub permite Pages privado antes de publicar.

## Limite de segurança

O aplicativo prepara e confere o lote, mas não armazena credenciais nem envia dados diretamente ao SIGGMA. A gravação é feita em uma sessão autenticada, com confirmação do usuário, para reduzir o risco de duplicidades.
