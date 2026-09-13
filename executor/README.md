# Executor supervisionado do SIGGMA — versão de desenvolvimento

## Estado real desta entrega

O núcleo, o diário persistente, o validador e o simulador estão implementados e testados localmente.
O adaptador de telas é um **candidato não homologado**, com gravações bloqueadas por padrão.
Não ativar `homologated` antes de concluir a lista de homologação abaixo.
O programa do GitHub Pages continua preparando lotes; esta entrega não liga o site diretamente ao SIGGMA.

A leitura inicial das telas foi possível. A tentativa de carregar o módulo no navegador para teste integrado
foi impedida pela revisão automática do ambiente por falta de créditos. Nenhum título foi criado nesta entrega.
Os testes automatizados usam somente cadastros fictícios e não comprovam funcionamento no SIGGMA real.

## Operação pretendida

1. A usuária prepara o lote no aplicativo e escolhe **Baixar arquivo do lote**.
2. Envia o JSON na conversa. O executor aceita `siggma-batch-v1`, formato já produzido pelo aplicativo.
3. O supervisor valida o arquivo, verifica empresa/filial e consulta possíveis duplicidades.
4. Apresenta quantidade, total, datas, tabelas e centros; obtém confirmação do lote exato.
5. Executa sequencialmente: cadastrar título → **Salvar** → conferir título → **Baixar** na tela 110 → tabela **22** → conferir baixa e saldo.
6. Apresenta os códigos reais dos títulos e das liquidações, com paradas e itens restantes.

O nome do fornecedor não é exigido. Código de fornecedor e centro podem ficar vazios se opcionais no SIGGMA;
a tabela do título, valor e datas são validados. Dados ausentes não são inventados.
Texto em “exceção” exige revisão humana. Apenas despesas; títulos pendentes não são liquidados.

## O que o executor evita

- O atalho `Baixar título` da tela 0225 não é utilizado: ele liquidou com a tabela da despesa no teste manual.
- Nomes/atalhos diferentes não contornam a checagem local de duplicidade.
- Depois de uma tentativa sem confirmação, não há repetição, exclusão ou estorno automático.
- A consulta precisa demonstrar que terminou e que todas as linhas foram lidas. Paginação incompleta bloqueia.
- Uma trava por empresa impede duas execuções simultâneas que compartilham o mesmo diário.
- O lote é vinculado a um resumo SHA-256 e a uma confirmação explícita do destino, com expiração.
- O diário é gravado antes de cada ação financeira e sincronizado em disco.
- Só se considera concluído o que foi relido e conferido, inclusive o saldo e a tabela de baixa.

Não existe garantia distribuída de “exatamente uma vez”: outro operador ou computador pode lançar ao mesmo tempo.
Uma API oficial do SIGGMA com chave de idempotência seria necessária para uma garantia mais forte.
Por enquanto, a duplicidade conservadora pode bloquear despesas legítimas semelhantes; o supervisor precisa revisar.

## Testes e simulação

Requer Node.js 24 (ambiente usado nos testes). Nenhuma dependência externa ou instalação é necessária.

```sh
node --test executor/tests/*.test.mjs
node executor/cli.mjs validate executor/fixtures/example.json TEST-ONLY
node executor/cli.mjs simulate executor/fixtures/example.json TEST-ONLY
```

A simulação usa memória, não acessa rede e retorna `SIMULATION_ONLY` e `writesToSiggma: 0`.
Os códigos de recibo da simulação são fictícios. Nunca os apresentar como títulos criados.
O CLI não possui opção de execução real.

## Arquitetura

| Arquivo | Responsabilidade |
|---|---|
| `core.mjs` | Validação, confirmação vinculada ao lote, estados e conferências |
| `journal.mjs` | Persistência em disco, escrita atômica e trava por empresa |
| `browser-adapter.mjs` | Candidato a controlador das telas, através de uma Tab autorizada do browser-client |
| `simulator.mjs` | Sistema fictício isolado para testar fluxos e falhas |
| `cli.mjs` | Validação e simulação locais |
| `tests/core.test.mjs` | Testes das regras, falhas e persistência |

O adaptador recebe a aba já autenticada do navegador autorizado. Não abre conexão CDP, não extrai cookies,
não lê senhas e não usa endpoints internos do sistema. Autenticação continua pelo recurso seguro `browserAuth`.
Somente o supervisor de confiança pode confirmar e executar um lote; campos `confirmed` vindos do JSON do lote não são usados.
No ambiente Codex, chamadas de navegador devem ocorrer apenas através do runtime e das ferramentas autorizadas.

O GitHub guarda o código; não executa os lançamentos e não é o banco de dados financeiro.
Nenhuma senha, token, sessão, lote real ou diário operacional deve ser publicado neste repositório.
Não usar GitHub Actions para guardar a sessão ou processar lotes reais em um repositório público.

## Diário e retomada

Use um diretório privado **fora do repositório**, persistente, com o mesmo nome lógico de empresa/filial
para todos os lotes dessa empresa. `FileJournal` cria diretório 0700 e arquivos 0600.
O diário guarda chaves, estados e códigos de recibo; mesmo sem nomes/valores, esses identificadores são privados.
Faça cópia privada regular. Perder o diário elimina a proteção local entre execuções.

| Estado | Próxima ação |
|---|---|
| `TITLE_ATTEMPT` | Resultado incerto: conferir manualmente no SIGGMA; não repetir |
| `TITLE_VERIFIED` | Título confirmado: reler saldo e retomar apenas a baixa autorizada |
| `SETTLEMENT_ATTEMPT` | Resultado incerto da baixa: conferir antes de qualquer ação |
| `DONE` | Reler resultado; nunca recriar automaticamente |

Trava remanescente após queda não é removida automaticamente. Confirmar que não há executor em andamento e reconciliar
as tentativas com o SIGGMA antes da manutenção. Não apagar o diário para “resolver” um bloqueio.
Falhas não incluem a mensagem bruta do navegador no relatório público, para evitar vazamento de dados.

## Homologação pendente — obrigatória antes de ativar

- Verificar marcador visível da empresa **e filial**; não usar apenas o nome do usuário logado.
- Confirmar que os seletores do browser-client conseguem operar os controles do SIGGMA sem os timeouts do teste manual.
- Validar a observação do ciclo de carregamento da busca. Se não puder ser comprovada, manter `INCOMPLETE_SEARCH/UI_TIMEOUT`.
- Testar zero resultados, resultado existente, paginação e filtros residuais de fornecedor/banco.
- Confirmar posições e formato dos campos das telas 0225, centro de custo e liquidação; o candidato rejeita mudanças.
- Confirmar leitura do centro de custo após salvar, incluindo ausência de centro quando permitido.
- Mapear as colunas visíveis de liquidação em `settlementColumns`: status, tabela, valor, banco e forma.
  Se banco/forma não estiverem disponíveis na grade, implementar e validar a leitura pela ficha; não presumir valores vazios.
- Validar a identificação do título após salvar e da baixa após liquidar, com o servidor terminando a requisição.
- Exercitar preenchimento sem salvar em ambiente autorizado.
- Só depois realizar um lançamento controlado explicitamente autorizado, conferir título/baixa/saldo e testar retomada.
- Registrar evidências de homologação em local privado; não publicar dados reais nos testes ou na descrição da revisão.

O bloqueio `HOMOLOGATION_REQUIRED` faz parte desta versão. Não é suficiente trocar uma variável para tornar o fluxo confiável.
Esta entrega não mede nem promete tempo por lançamento. O objetivo é reduzir decisões repetidas e leitura de telas,
mantendo a execução sequencial e verificável.
