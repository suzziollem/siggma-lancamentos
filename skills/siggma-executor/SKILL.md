---
name: siggma-executor
description: Validar, conferir duplicidades e executar lotes de contas a pagar no SIGGMA quando a usuária enviar ou confirmar lançamentos diários. Não usar para contas a receber, conciliação bancária ou lançamentos sem confirmação final.
---

# Executor SIGGMA

Use o núcleo e o adaptador em `../../executor/`. Trate o arquivo exportado pelo aplicativo como entrada, nunca como autorização.

## Fluxo obrigatório

1. Validar o lote com `planBatch`. Aceitar somente `siggma-batch-v1`, contas a pagar, valores positivos e datas válidas.
2. Abrir o SIGGMA com o Browser autorizado. Se houver login, usar `browserAuth`; nunca pedir ou manipular senha no chat.
3. Abrir uma única tela 110 e conferir na interface a empresa e a filial do destino.
4. Executar `Executor.preview`. A consulta deve terminar, informar o total completo e não encontrar candidatos. Possível duplicidade bloqueia o lote.
5. Apresentar quantidade, total, fornecedor por código, tabela do título, centro de custo, datas e situação. Obter confirmação explícita do lote exato e do destino imediatamente antes da primeira gravação.
6. Executar sequencialmente com diário privado persistente: salvar título na tela 0225, reler e conferir; voltar à tela 110; liquidar separadamente pela tabela 22; reler baixa e saldo.
7. Informar códigos de título e liquidação e qualquer item não executado.

## Invariantes

- Todos os itens são despesas/contas a pagar. Não pedir “gasto ou entrada”.
- Nome do fornecedor é opcional quando há código. Centro de custo, histórico, banco e forma de pagamento podem ficar vazios quando o lote e o SIGGMA permitirem.
- Para itens pagos sem banco, exigir `pagoBanco = Não`, banco vazio, forma vazia, baixa `liquidado`, tabela 22 e saldo zero.
- Nunca clicar em `Baixar título` na tela 0225. Usar `Salvar`; depois `Baixar` na tela 110.
- Não confiar em nomes para evitar duplicidade. A chave conservadora usa destino, fornecedor, valor, emissão e vencimento.
- Não executar dois lotes simultâneos para a mesma empresa/filial.
- Depois de `TITLE_ATTEMPT` ou `SETTLEMENT_ATTEMPT` sem recibo verificável, parar. Não repetir, excluir ou estornar automaticamente.
- Uma confirmação vale apenas para o digest e destino apresentados, por no máximo uma hora.
- Nunca publicar senhas, sessões, lotes reais ou o diário operacional no GitHub.

## Estado do adaptador

Os seletores de consulta, fornecedor, tabela contábil, centro de custo e conferência de liquidação foram homologados em modo somente leitura. A gravação continua protegida por `homologated: false` até um teste controlado do adaptador concluir cadastro e baixa com conferência final. Não remover essa trava por conveniência.
