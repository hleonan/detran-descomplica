"""Entrada da Fase de Ação do robô SEI.

Compatível com execução direta do arquivo (`python scripts/acao.py`) e como módulo
(`python -m scripts.acao`).
"""

if __package__:
    from .sei_despacho_ppp import main
else:
    from sei_despacho_ppp import main


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
