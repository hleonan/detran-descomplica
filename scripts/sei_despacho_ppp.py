import asyncio
import os
import re
from datetime import datetime

import gspread
from dotenv import load_dotenv
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

load_dotenv()

SEI_URL = os.getenv("SEI_URL")
SEI_USER = os.getenv("SEI_USUARIO")
SEI_PASS = os.getenv("SEI_SENHA")
SEI_ORGAO = os.getenv("SEI_ORGAO", "RIOLUZ")
HEADLESS = os.getenv("HEADLESS", "0") == "1"
DEBUG_INSPECIONAR = os.getenv("SEI_DEBUG_INSPECIONAR", "1") == "1"
SPREADSHEET_NAME = os.getenv("SPREADSHEET_NAME", "Controle SEI - Rioluz")
CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE", "credentials.json")

X_USUARIO = '//*[@id="txtUsuario"]'
X_SENHA = '//*[@id="pwdSenha"]'
X_ORGAO = '//*[@id="selOrgao"]'

if not SEI_URL or not SEI_USER or not SEI_PASS:
    raise ValueError("SEI_URL, SEI_USUARIO e SEI_SENHA devem existir no .env")


def get_sheet():
    base_dir = os.path.dirname(__file__)
    candidate_paths = [
        os.path.abspath(os.path.join(base_dir, "..", CREDENTIALS_FILE)),
        os.path.abspath(os.path.join(base_dir, "..", "..", CREDENTIALS_FILE)),
        os.path.abspath(CREDENTIALS_FILE),
    ]

    creds_path = next((p for p in candidate_paths if os.path.exists(p)), None)
    if not creds_path:
        raise FileNotFoundError(
            "credentials.json não encontrado. Defina GOOGLE_CREDENTIALS_FILE no .env "
            "ou coloque o arquivo na raiz do projeto."
        )

    client = gspread.service_account(filename=creds_path)
    return client.open(SPREADSHEET_NAME).sheet1


async def click_first_visible(container, selectors, timeout_ms=3000):
    for selector in selectors:
        locator = container.locator(selector).first
        try:
            await locator.wait_for(state="visible", timeout=timeout_ms)
            await locator.click()
            return True
        except PlaywrightTimeoutError:
            continue
    return False


async def marcar_radio_resiliente(frame, seletor_input, seletor_label=None):
    radio = frame.locator(seletor_input).first
    await radio.wait_for(state="visible", timeout=15000)

    try:
        await radio.check(timeout=3000)
        return
    except PlaywrightTimeoutError:
        pass

    if seletor_label:
        label = frame.locator(seletor_label).first
        if await label.count() > 0:
            try:
                await label.click(timeout=3000)
                return
            except PlaywrightTimeoutError:
                pass

    # fallback final: marca via JS e dispara eventos usados no SEI
    await radio.evaluate(
        """(el) => {
            el.checked = true;
            el.dispatchEvent(new Event('click', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof configurarTextoInicial === 'function') {
                configurarTextoInicial();
            }
        }"""
    )


async def try_click_login(page):
    if await click_first_visible(
        page,
        ["text=Acessar", "text=Entrar", "text=Login", "#sbmLogin", "button[type='submit']"],
    ):
        return True
    await page.keyboard.press("Enter")
    return True


async def login_sei(page):
    print("[*] Login no SEI...")
    await page.goto(SEI_URL, wait_until="domcontentloaded")
    await page.locator(X_USUARIO).fill(SEI_USER)
    await page.locator(X_SENHA).fill(SEI_PASS)

    if await page.locator(X_ORGAO).count() > 0:
        await page.locator(X_ORGAO).select_option(label=SEI_ORGAO)

    await try_click_login(page)
    await page.wait_for_load_state("networkidle")

    if "procedimento_controlar" not in page.url and "procedimento_trabalhar" not in page.url:
        await page.goto(
            "https://prefeitura.sei.rio/sei/controlador.php?acao=procedimento_controlar&acao_origem=procedimento_controlar&id_orgao_acesso_externo=0",
            wait_until="domcontentloaded",
        )

    print("[OK] Sessão ativa.")


async def localizar_frame_visualizacao(page, timeout_ms=15000):
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while asyncio.get_event_loop().time() < deadline:
        for frame in page.frames:
            if frame.is_detached():
                continue

            name = frame.name or ""
            url = frame.url or ""

            if "ifrVisualizacao" in name or "acao=documento_" in url or "documento_" in url:
                return frame

            if await frame.locator("input#txtFiltro, input#txtDescricao, input[name='rdoTextoInicial']").count() > 0:
                return frame

        await page.wait_for_timeout(300)

    return None


async def localizar_e_clicar_incluir_documento(page):
    seletor_img = 'img[title="Incluir Documento"]'
    seletor_link = 'a[href*="documento_escolher_tipo"]'

    for _ in range(20):
        for frame in page.frames:
            if frame.is_detached():
                continue

            for seletor in (seletor_img, seletor_link):
                botao = frame.locator(seletor).first
                if await botao.count() == 0:
                    continue
                if await botao.is_visible():
                    await botao.click()
                    return True

        await page.wait_for_timeout(500)

    return False


async def abrir_despacho_no_frame(frame):
    await frame.locator("input#txtFiltro").wait_for(state="visible", timeout=15000)
    await frame.locator("input#txtFiltro").fill("Despacho")

    link = frame.get_by_role("link", name=re.compile(r"^Despacho$", re.I)).first
    await link.wait_for(state="visible", timeout=10000)
    await link.click()

    # Em alguns ambientes SEI o valor de "Documento Modelo" pode variar
    # (ex.: value='M' ou value='D'), então priorizamos id/label e deixamos fallback.
    radio_modelo = frame.locator(
        "input#optProtocoloDocumentoTextoBase, input[name='rdoTextoInicial'][value='M'], input[name='rdoTextoInicial'][value='D']"
    ).first
    await radio_modelo.wait_for(state="visible", timeout=15000)
    await marcar_radio_resiliente(
        frame,
        "input#optProtocoloDocumentoTextoBase, input[name='rdoTextoInicial'][value='M'], input[name='rdoTextoInicial'][value='D']",
        "label[for='optProtocoloDocumentoTextoBase']",
    )

    # Garante que os campos do protocolo modelo ficaram habilitados após a seleção.
    await frame.locator("input#txtProtocoloDocumentoTextoBase").wait_for(state="visible", timeout=10000)


async def preencher_formulario_despacho(frame):
    await frame.locator("input#txtProtocoloDocumentoTextoBase").fill("1766545")
    await frame.locator("input#txtProtocoloDocumentoTextoBase").press("Tab")

    await frame.locator("input#txtDescricao").fill("IMPLANTAÇÃO")

    nome_arvore = frame.locator("input#txtNomeArvore")
    if await nome_arvore.count() > 0 and await nome_arvore.first.is_visible():
        await nome_arvore.fill("DTP")

    publico = frame.locator(
        "input#optPublico, input#optPublicoInfra, input[value='2'][name='rdoNivelAcesso']"
    ).first
    if await publico.count() > 0:
        try:
            await publico.check(timeout=3000)
        except PlaywrightTimeoutError:
            await publico.click(force=True)


async def salvar_editor_com_data(page, frame):
    editor = None
    botao_salvar = frame.locator(
        "button#btnSalvar, input#btnSalvar, button:has-text('Salvar'), input[value='Salvar']"
    ).first

    try:
        async with page.context.expect_page(timeout=8000) as popup_info:
            await botao_salvar.click()
        editor = await popup_info.value
        await editor.wait_for_load_state("domcontentloaded")
    except PlaywrightTimeoutError:
        # Fallback: alguns perfis abrem editor na mesma aba/frame em vez de popup.
        await botao_salvar.click()
        await page.wait_for_timeout(2500)
        editor = page

    await editor.wait_for_function(
        "typeof CKEDITOR !== 'undefined' && Object.keys(CKEDITOR.instances).length > 0",
        timeout=15000,
    )

    hoje = datetime.now().strftime("%d/%m/%Y")
    await editor.evaluate(
        """(hoje) => {
            const key = Object.keys(CKEDITOR.instances)[0];
            const editor = CKEDITOR.instances[key];
            const html = editor.getData().replace(/\\d{2}\\/\\d{2}\\/\\d{4}/g, hoje);
            editor.setData(html);
        }""",
        hoje,
    )

    clicou_salvar = await click_first_visible(
        editor,
        [
            "a[onclick*='salvar']",
            "img[title*='Salvar']",
            "input[id*='Salvar']",
            "a[id*='Salvar']",
            "button:has-text('Salvar')",
            "text=Salvar",
        ],
        timeout_ms=5000,
    )

    if not clicou_salvar:
        raise RuntimeError("Não foi possível acionar o botão Salvar no editor do SEI.")

    await editor.wait_for_timeout(2000)
    if editor != page and not editor.is_closed():
        await editor.close()


async def inspecionar_pagina(page):
    """Inspeciona os elementos principais do fluxo para debug operacional no SEI."""
    if not DEBUG_INSPECIONAR:
        return

    print("[DEBUG] Inspecionando frames e elementos visíveis da página...")
    seletores = [
        "input#txtPesquisaRapida",
        "img[title='Incluir Documento']",
        "a[href*='documento_escolher_tipo']",
        "input#txtFiltro",
        "a:has-text('Despacho')",
        "input#optProtocoloDocumentoTextoBase",
        "input#txtProtocoloDocumentoTextoBase",
        "input#txtDescricao",
        "input#txtNomeArvore",
        "input#optPublico",
        "input#optPublicoInfra",
        "button#btnSalvar",
        "input#btnSalvar",
    ]

    for idx, frame in enumerate(page.frames):
        if frame.is_detached():
            continue

        frame_nome = frame.name or "(sem nome)"
        frame_url = frame.url or "(sem url)"
        print(f"[DEBUG] Frame {idx}: {frame_nome} | {frame_url}")

        for selector in seletores:
            try:
                total = await frame.locator(selector).count()
                if total > 0:
                    visiveis = await frame.locator(selector).evaluate_all(
                        "els => els.filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).length"
                    )
                    print(f"    - {selector}: total={total}, visiveis={visiveis}")
            except Exception:
                continue


async def processar_despacho_ppp(page, numero_processo):
    print(f"\n=== Processo {numero_processo} ===")
    try:
        pesquisa = page.locator("input#txtPesquisaRapida")
        await pesquisa.wait_for(state="visible", timeout=10000)
        await pesquisa.fill(numero_processo)
        await pesquisa.press("Enter")
        await page.wait_for_timeout(2500)
        await inspecionar_pagina(page)

        if not await localizar_e_clicar_incluir_documento(page):
            raise RuntimeError("Não foi possível clicar em 'Incluir Documento'.")

        frame = await localizar_frame_visualizacao(page)
        if not frame:
            raise RuntimeError("Frame de visualização não encontrado após incluir documento.")

        await abrir_despacho_no_frame(frame)
        await inspecionar_pagina(page)
        await preencher_formulario_despacho(frame)
        await inspecionar_pagina(page)
        await salvar_editor_com_data(page, frame)

        print("[OK] Despacho criado com sucesso.")
        return True
    except Exception as exc:
        print(f"[ERRO] Falha no processo {numero_processo}: {exc}")
        await page.screenshot(path=f"erro_despacho_{numero_processo}.png", full_page=True)
        return False


async def main():
    sheet = get_sheet()
    registros = sheet.get_all_records()

    alvos = []
    for idx, linha in enumerate(registros):
        numero = str(linha.get("processo_numero", "")).strip()
        classificacao = str(linha.get("classificacao", "")).strip().upper()
        acao_adm = str(linha.get("acao_adm", "")).strip().upper()
        status_sei = str(linha.get("Status Sei", "")).strip().upper()

        if numero and classificacao == "RETORNO/TRAMITAÇÃO" and "CRIAR DESPACHO PARA PPP" in acao_adm:
            if "DESPACHO CRIADO" not in status_sei:
                alvos.append({"num": numero, "row_index": idx + 2})

    if not alvos:
        print("Nenhum processo pendente para Despacho PPP.")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=HEADLESS)
        context = await browser.new_context()
        page = await context.new_page()

        await login_sei(page)

        for alvo in alvos:
            sucesso = await processar_despacho_ppp(page, alvo["num"])
            if sucesso:
                sheet.update_cell(alvo["row_index"], 12, "DESPACHO CRIADO (Aguardando Tramitação)")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
