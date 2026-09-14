# Executor supervisionado do SIGGMA — versão de desenvolvimento

## Estado real desta entrega

O núcleo, o diário persistente, o validador e o simulador estão implementados e testados localmente.
O adaptador de telas teve seus fluxos de consulta, cadastro, liquidação e conferência
**homologados em um teste controlado**. As gravações continuam bloqueadas por padrão:
`homologated` só pode ser habilitado pelo executor depois de validar empresa/filial,
duplicidades, o resumo do lote e a confirmação explícita da usuária.
O programa do GitHub Pages continua preparando lotes; esta entrega não liga o site diretamente ao SIGGMA.

O módulo corrigido foi carregado no navegador autorizado e executou consultas reais, cadastro controlado,
baixa na tabela 22 e releitura final de títulos, centros, liquidações, saldo e opcionais. A execução confirmou
que título e baixa devem permanecer separados. Os testes automatizados usam somente cadastros fictícios.

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
| `../skills/siggma-executor/` | Rotina reutilizável do Codex para lotes diários |

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

## Homologação

Concluído em modo somente leitura:

- marcador visível da empresa e da filial;
- ciclo de carregamento, total completo e busca de possível duplicidade;
- limpeza dos filtros múltiplos pela própria interface;
- máscaras de valor e datas;
- seletores de tabela, fornecedor, centro de custo e liquidação;
- leitura estável do rateio depois da renderização assíncrona;
- tabela 22, valor, status, banco, forma de pagamento e saldo na baixa existente;
- preenchimento de um rascunho completo e cancelamento sem salvar.

Condições permanentes para habilitar uma execução:

- confirmação explícita do lote e do destino, imediatamente antes da primeira gravação;
- consulta completa de duplicidades e conferência de empresa/filial;
- diário operacional disponível antes de cada ação financeira;
- parada obrigatória se o recibo do título ou da baixa não puder ser verificado;
- evidências privadas: nunca publicar dados reais no repositório.

O bloqueio `HOMOLOGATION_REQUIRED` continua fazendo parte desta versão. Não basta trocar uma variável:
o executor precisa preservar todas as verificações acima em cada lote.
Esta entrega não mede nem promete tempo por lançamento. O objetivo é reduzir decisões repetidas e leitura de telas,
mantendo a execução sequencial e verificável.
