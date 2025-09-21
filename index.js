// index.js
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import { GoogleSpreadsheet } from 'google-spreadsheet'
import fs from 'fs'

// 📌 Configurações das planilhas
const PLANILHA_CADASTROS = '1QDP8Uo71gL_T9efOqtmSc5AoBTnYA8DlpgzYbTVIhoY'
const PLANILHA_PEDIDOS = '1RbzDCYh7xaVmOxD1JLWDfpiw9HKhtw4r2zKxcmCfFsE'

// 📌 Carregar credenciais do Google
// 📌 Carregar credenciais do Google
let credentials
if (process.env.CREDENCIAIS_JSON) {
    // se estiver rodando na nuvem (Railway/Render), pega do ENV
    credentials = JSON.parse(process.env.CREDENCIAIS_JSON)
} else {
    // se estiver rodando localmente, lê o arquivo
    const CREDENCIAIS_PATH = './credentials.json'
    credentials = JSON.parse(fs.readFileSync(CREDENCIAIS_PATH, 'utf-8'))
}

// Estado temporário para cada usuário
const userState = {}

// Estrutura de pedidos em construção (por usuário)
function inicializarPedido() {
    return {
        paciente: '',
        itens: []
    }
}

// 📌 Normaliza número do WhatsApp para formato da planilha
function normalizarNumero(sender) {
    let numero = sender.replace(/@s.whatsapp.net/, '').replace(/\D/g, '')
    if (numero.startsWith('55')) {
        numero = numero.slice(2)
    }
    return numero
}

// Reinicia temporizador do usuário
function resetUserTimeout(sender) {
    if (userState[sender]?.timeout) {
        clearTimeout(userState[sender].timeout)
    }
    userState[sender].timeout = setTimeout(() => {
        console.log(`⏱️ Tempo esgotado para ${sender}, reiniciando fluxo.`)
        delete userState[sender]
    }, 120000)
}

// Função para recuperar dados de uma aba
async function getSheetData(sheetId, aba) {
    const doc = new GoogleSpreadsheet(sheetId)
    await doc.useServiceAccountAuth(credentials)
    await doc.loadInfo()
    const worksheet = doc.sheetsByTitle[aba]
    const rows = await worksheet.getRows()
    return rows.map(r => {
        const obj = {}
        worksheet.headerValues.forEach((h, i) => obj[h] = r._rawData[i])
        return obj
    })
}

// Função para validar Nome + CRO
function validarNomeCRO(resposta) {
    const partes = resposta.trim().split(/\s+/)
    if (partes.length < 2) return false
    const nome = partes.slice(0, -1).join(' ')
    const cro = partes[partes.length - 1]
    return nome.length >= 4 && /^\d{3,}$/.test(cro)
}

// Função para salvar dentista em CLI_APR
async function salvarDentistaAproximacao(numero, resposta) {
    const doc = new GoogleSpreadsheet(PLANILHA_CADASTROS)
    await doc.useServiceAccountAuth(credentials)
    await doc.loadInfo()
    const aba = doc.sheetsByTitle['CLI_APR']
    await aba.addRow({
        FONE_APR: numero,
        RESPOSTA: resposta,
        DATA_REGISTRO: new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' })
    })
}

// Função para identificar perfil
async function identificarPerfil(sender) {
    const numero = normalizarNumero(sender)

    const admins = await getSheetData(PLANILHA_CADASTROS, 'ADM_BOT')
    const admin = admins.find(a => a.FONE_ADM?.replace(/\D/g, '') === numero)
    if (admin) return { perfil: 'admin', nome: admin.NOME }

    const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')
    const cliente = clientes.find(c => c.FONE?.replace(/\D/g, '') === numero)
    if (cliente) {
        const prefixo = cliente.SEXO === 'F' ? 'Dra' : 'Dr'
        return { perfil: 'dentista', nome: `${prefixo}. ${cliente.NOME_CLI}` }
    }

    return { perfil: 'desconhecido', nome: null }
}

// Função para gerar número de pedido
async function gerarNumeroPedido() {
    const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
    const ult = pedidos.map(p => parseInt(p.NR_PED) || 0).sort((a, b) => b - a)[0] || 0
    return ult + 1
}

// Função para buscar valor do catálogo de um produto
async function getValorCatalogo(produtoNome) {
    const doc = new GoogleSpreadsheet(PLANILHA_CADASTROS) // << agora usa a planilha CADASTROS
    await doc.useServiceAccountAuth(credentials)
    await doc.loadInfo()

    const aba = doc.sheetsByTitle['PRODUTOS'] // << aba PRODUTOS
    if (!aba) {
        console.error('Aba "PRODUTOS" não encontrada na planilha de CADASTROS.')
        return ''
    }

    // Se os headers estiverem na linha 1, não precisa mexer. 
    // Se estiverem em outra linha, descomente e ajuste:
    // await aba.loadHeaderRow(1)

    const rows = await aba.getRows()

    const alvo = String(produtoNome || '').trim().toLowerCase()
    const encontrado = rows.find(r => String(r['PRODUTO'] || '').trim().toLowerCase() === alvo)

    if (!encontrado) {
        console.warn(`Produto não encontrado em CADASTROS > PRODUTOS: "${produtoNome}"`)
        return ''
    }

    // Tenta ambas as variações de header, por segurança
    return (encontrado['VLR_CAT'] ?? encontrado['VLR CAT'] ?? '').toString().trim()
}
// Função para salvar pedido
async function salvarPedido(clienteNome, pedido) {
    const doc = new GoogleSpreadsheet(PLANILHA_PEDIDOS)
    await doc.useServiceAccountAuth(credentials)
    await doc.loadInfo()
    const abaPedidos = doc.sheetsByTitle['PEDIDOS']
    const abaItens = doc.sheetsByTitle['PEDIDOS_ITENS']
    const nrPed = await gerarNumeroPedido()
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

    // grava o pedido principal
    await abaPedidos.addRow({
        NR_PED: nrPed,
        STATUS: 'Pedido Registrado',
        CLIENTE: clienteNome,
        PACIENTE: pedido.paciente,
        DT_PED: hoje
    })

    // grava os itens do pedido
    for (const item of pedido.itens) {
        // ✅ garante que o valor do catálogo está atualizado
        const valorCatalogo = await getValorCatalogo(item.produto)

        await abaItens.addRow({
            NR_PED: nrPed,
            PRODUTO: item.produto,
            QTDE: item.qtde,
            COR: item.cor,
            OBS: item.obs || '',
            VLR_COB: valorCatalogo || '' // ✅ sempre gravado do catálogo
        })
    }

    return nrPed
}

// Função para buscar pedidos de um cliente (detalhado)
async function getPedidosCliente(clienteNome, perfil = 'admin') {
    const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
    const pedidosItens = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS_ITENS')

    const clientePedidos = pedidos.filter(p => p.CLIENTE === clienteNome)
    if (clientePedidos.length === 0) return '❌ Este cliente não possui pedidos cadastrados.'

    let msgPedidos = `👨‍⚕️ *${clienteNome}*\n\n`

    for (let i = 0; i < clientePedidos.length; i++) {
        const p = clientePedidos[i]
        const nrPed = p.NR_PED
        const status = p.STATUS
        const dataPed = p.DT_PED
        const paciente = p.PACIENTE
        const dtPrazo = p.DT_PRAZO
        const vlrPed = p.VLR_PED
        const custTerc = p.CUST_TERC

        let prazoInfo = ''
        if (dtPrazo) {
            const hoje = new Date()
            const prazo = new Date(dtPrazo.split('/').reverse().join('-'))
            const diffTime = prazo.getTime() - hoje.getTime()
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
            prazoInfo = diffDays >= 0 ? `- faltam ${diffDays} dias -` : `- ‼️ atrasado ${Math.abs(diffDays)} dias -`
        }

        const itens = pedidosItens.filter(pi => pi.NR_PED === nrPed)
        let itensMsg = ''
        itens.forEach((prod, j) => {
            itensMsg += `${j + 1}️⃣ *${prod.PRODUTO}*\n`
            itensMsg += `   Qtd: ${prod.QTDE} | Cor: ${prod.COR || '—'}\n`
            itensMsg += `   Valor do Catálogo: ${prod.VLR_CAT}\n`
            itensMsg += `   Valor Cobrado: ${prod.VLR_COB}\n`
            itensMsg += `   Total do Item: ${prod.TOTAL_PROD}\n\n`
        })

        msgPedidos += `📌 NR PEDIDO: *${nrPed} (${status})*\n`
        msgPedidos += `🧑‍⚕️ Paciente: *${paciente}*\n`
        msgPedidos += `🗓️ Data Pedido: *${dataPed}*\n`
        msgPedidos += `📅 Prazo Entrega: *${dtPrazo}* (${prazoInfo})\n\n`
        msgPedidos += `📦 *ITENS DO PEDIDO:*\n\n${itensMsg}`
        msgPedidos += `💰 TOTAL PEDIDO: *${vlrPed}*\n`

        // 👇 Só exibe custo de terceirização para Admin
        if (perfil === 'admin') {
            msgPedidos += `⚙️ Custo Terceirização: *${custTerc}*\n`
        }

        if (i < clientePedidos.length - 1) {
            msgPedidos += `━━━━━━━━━━━━━━━\n`
        }
    }

    return msgPedidos
}

// 📩 Inicia o bot
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: false
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) qrcode.generate(qr, { small: true })
        if (connection === 'open') console.log('✅ Bot conectado com sucesso!')
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('⚠️ Conexão fechada.', shouldReconnect ? 'Reconectando...' : 'Logout detectado.')
            if (shouldReconnect) startBot()
        }
    })

    // 📩 Listener
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return
        const sender = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
        console.log(`📩 Mensagem recebida de ${sender}: ${text}`)
        const estado = userState[sender]

        // === Identificação inicial ===
		if (!estado) {
			const { perfil, nome } = await identificarPerfil(sender)
			if (perfil === 'admin') {
				await sock.sendMessage(sender, {
					text: `👋 Olá *${nome}*! Aqui está o Menu Principal:\n━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
				})
				userState[sender] = { perfil, etapa: 'menu_admin', nome }
				resetUserTimeout(sender)
				return
			}
            if (perfil === 'dentista') {
                await sock.sendMessage(sender, {
                    text: `👋 Olá *${nome}*! Como podemos te ajudar hoje?\n━━━━━━━━━━━━━━━\n1️⃣ Consultar Meus Pedidos\n2️⃣ Fazer um Novo Pedido\n3️⃣ Falar com Alguém\n━━━━━━━━━━━━━━━`
                })
                userState[sender] = { perfil, etapa: 'inicio', nome }
                resetUserTimeout(sender)
                return
            }
            if (perfil === 'desconhecido') {
                await sock.sendMessage(sender, {
                    text: `👋 Bem vindo ao laboratório *AURA ESTÉTICA DE ALTA PERFORMANCE*.\nEscolha uma das opções:\n━━━━━━━━━━━━━━━\n1️⃣ Sou Dentista\n2️⃣ Não sou Dentista / Falar com alguém\n━━━━━━━━━━━━━━━`
                })
                userState[sender] = { perfil: 'desconhecido', etapa: 'menu_inicial' }
                resetUserTimeout(sender)
                return
            }
        }

        // === Fluxo Admin ===
        if (estado?.perfil === 'admin') {
            resetUserTimeout(sender)

            // Etapa inicial
			 if (estado.etapa === 'inicio') {
				if (text === '1') {
					await sock.sendMessage(sender, {
						text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
					})
					estado.etapa = 'menu_admin'
					return
				}
            }

            // === Menu Principal Admin ===
			if (estado.etapa === 'menu_admin') {
				if (text === '0') {
					await sock.sendMessage(sender, {
						text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
					})
					return
				}

               
				// 1 PEDIDOS A RECEBER
				if (text === '1') {
					const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
					const pedidosReceber = pedidos.filter(
						p => p.STATUS === 'Entregue' && (!p.PAGO || String(p.PAGO).trim() === '')
					)

					if (pedidosReceber.length === 0) {
						await sock.sendMessage(sender, { text: '✅ Não existem pedidos a receber.' })
						return
					}

					// 👉 guarda lista e muda etapa
					estado.etapa = 'menu_admin_receber'
					estado.pedidosReceber = pedidosReceber

					// carrega clientes
					const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')

					// organiza por cliente
					const clientesMap = {}
					pedidosReceber.forEach(p => {
						if (!clientesMap[p.CLIENTE]) clientesMap[p.CLIENTE] = []
						clientesMap[p.CLIENTE].push(p)
					})

					// calcula total geral
					const totalGeral = pedidosReceber.reduce((acc, p) => {
						let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
						return acc + (parseFloat(v) || 0)
					}, 0)
					const totalGeralFmt = totalGeral.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

					let msg = `💵 *PEDIDOS A RECEBER*\n      _Total Geral: ${totalGeralFmt}_\n━━━━━━━━━━━━━━━\n`

					let contador = 1
					for (const clienteNome in clientesMap) {
						const lista = clientesMap[clienteNome]

						// busca cadastro do cliente
						const cadastro = clientes.find(c => c.NOME_CLI === clienteNome)
						let titulo = clienteNome
						if (cadastro) {
							const prefixo = cadastro.SEXO === 'F' ? '👩‍⚕️ Dra.' : '👨‍⚕️ Dr.'
							const primeiroNome = String(cadastro.NOME_CLI || '').split(' ')[0]
							titulo = `${prefixo} *${primeiroNome}* CRO ${cadastro.CRO || ''}`
						}

						// soma total do cliente
						const totalCliente = lista.reduce((acc, p) => {
							let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
							return acc + (parseFloat(v) || 0)
						}, 0)
						const totalClienteFmt = totalCliente.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

						msg += `${titulo}\n💰 *Total: ${totalClienteFmt}*\n\n`

						// ordena pedidos por entrega mais antiga
						lista.sort((a, b) => {
							const da = new Date(a.DT_ENTREG?.split('/').reverse().join('-'))
							const db = new Date(b.DT_ENTREG?.split('/').reverse().join('-'))
							return da - db
						})

						lista.forEach(p => {
							let dias = ''
							if (p.DT_ENTREG) {
								const hoje = new Date()
								const dataEnt = new Date(p.DT_ENTREG.split('/').reverse().join('-'))
								const diffDays = Math.floor((hoje - dataEnt) / (1000 * 60 * 60 * 24))
								dias = `há ${diffDays} dia(s)`
							}

							msg += `${contador}️⃣ Pedido *${p.NR_PED}* entregue ${dias}\n`
							msg += `   - Valor: ${p.VLR_PED}\n`
							msg += `️   - _Paciente: ${p.PACIENTE}_\n`
							if (p.OBS) msg += `   - Obs: ${p.OBS}\n`
							msg += `\n`
							contador++
						})

						msg += `━━━━━━━━━━━━━━━\n`
					}

					await sock.sendMessage(sender, { text: msg })
					estado.etapa = 'menu_admin'
					return
				}

				// 2 PEDIDOS POR PRAZO
				if (text === '2') {
					const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
					const pendentes = pedidos.filter(p => p.STATUS !== 'Entregue')
					const hoje = new Date()
					const atrasados = []
					const hojeList = []
					const futuro = []

					pendentes.forEach(p => {
						if (!p.DT_PRAZO) return
						const prazo = new Date(p.DT_PRAZO.split('/').reverse().join('-'))
						const diff = Math.floor((prazo - hoje) / (1000 * 60 * 60 * 24))

						if (diff < 0) atrasados.push(p)
						else if (diff === 0) hojeList.push(p)
						else futuro.push(p)
					})

					let msg = `📅 *PEDIDOS POR PRAZO*\n━━━━━━━━━━━━━━━\n`
					msg += `1️⃣ ⚠ *Atrasados: ${atrasados.length} pedido(s)*\n`
					msg += `2️⃣ ⏰ Hoje: ${hojeList.length} pedido(s)\n`
					msg += `3️⃣ ✅ Futuros: ${futuro.length} pedido(s)\n`
					msg += `0️⃣ 🔙 Voltar Menu Anterior\n━━━━━━━━━━━━━━━`

					await sock.sendMessage(sender, { text: msg })
					estado.etapa = 'menu_admin_prazo'
					estado.pedidosPrazo = { atrasados, hojeList, futuro }
					return
				}

				// 3 PEDIDOS POR STATUS
				if (text === '3') {
					const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
					const pedidosNaoPagos = pedidos.filter(p => !p.PAGO || String(p.PAGO).trim() === '')
					const statusList = [...new Set(
						pedidosNaoPagos
							.map(p => p.STATUS)
							.filter(s => s && s !== 'Entregue')
)]

					let msg = '📊 *Pedidos por Status (somente não pagos)*\n━━━━━━━━━━━━━━━\n'
					statusList.forEach((status, i) => {
						const qtd = pedidosNaoPagos.filter(p => p.STATUS === status).length
						msg += `${i + 1}️⃣ ${status} | ${qtd} pedido(s)\n`
					})
					msg += `━━━━━━━━━━━━━━━\n0️⃣ Para Voltar Menu Principal`

					if (statusList.length === 0) msg = '✅ Não existem pedidos em aberto por status.'

					await sock.sendMessage(sender, { text: msg })
					estado.etapa = 'menu_admin_status'
					estado.statusList = statusList
					return
				}

				// 4 PEDIDOS POR CLIENTE
				if (text === '4') {
					const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
					const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')
					const clientesPedidos = [...new Set(pedidos.map(p => p.CLIENTE).filter(Boolean))]

					let msgList = '📑 *Pedidos por Cliente*\nDigite o número do cliente:\n━━━━━━━━━━━━━━━\n'
					const listaExibida = []

					for (const c of clientesPedidos) {
						const cadastro = clientes.find(cli => cli.NOME_CLI === c)
						if (!cadastro) continue

						const pedidosNaoPagos = pedidos.filter(p => p.CLIENTE === c && (!p.PAGO || String(p.PAGO).trim() === ''))
						if (pedidosNaoPagos.length === 0) continue

						const total = pedidosNaoPagos.reduce((acc, p) => {
							let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
							return acc + (parseFloat(v) || 0)
						}, 0)

						const prefixo = cadastro.SEXO === 'F' ? 'Dra' : 'Dr'
						const primeiroNome = String(cadastro.NOME_CLI || '').split(' ')[0]
						const cro = cadastro.CRO || ''
						const totalFormatado = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

						const idx = listaExibida.length + 1
						msgList += `${idx}️⃣ ${prefixo} *${primeiroNome}* CRO ${cro}\n   _${pedidosNaoPagos.length} pedido(s), total ${totalFormatado}_\n\n`

						listaExibida.push(c)
					}

					if (listaExibida.length === 0) {
						msgList += '✅ Todos os clientes estão com seus pedidos pagos.'
					}

					await sock.sendMessage(sender, { text: msgList })
					estado.etapa = 'menu_admin_pedidos'
					estado.clientesPedidos = listaExibida
					return
				}

				// 5 IR PARA O MENU DE CADASTROS
				if (text === '5') {
					let msg = `📋 *CONSULTA CADASTROS*\n━━━━━━━━━━━━━━━\n`
					msg += `1️⃣ Clientes\n`
					msg += `2️⃣ Pacientes\n`
					msg += `3️⃣ Produtos\n`
					msg += `4️⃣ Clientes a Cadastrar\n`
					msg += `5️⃣ Administradores\n`
					msg += `━━━━━━━━━━━━━━━\n0️⃣ 🔙 Voltar ao Menu Anterior\n━━━━━━━━━━━━━━━`

					await sock.sendMessage(sender, { text: msg })
					estado.etapa = 'menu_admin_cadastros'
					return
				}

				
            }
        }
				// === Submenu: Consulta Cadastros ===
				if (estado.etapa === 'menu_admin_cadastros') {
					if (text === '0') {
						await sock.sendMessage(sender, {
							text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
						})
						estado.etapa = 'menu_admin'
						return
					}

					// 1 CLIENTES
					if (text === '1') {
						const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')
						if (clientes.length === 0) {
							await sock.sendMessage(sender, { text: '❌ Nenhum cliente cadastrado.' })
							return
						}

						const list = clientes.map((c, i) => {
							const nome = c.NOME_CLI || '—'
							const cro = c.CRO || '—'
							const fone = c.FONE || '—'
							const sexo = (c.SEXO || '').toUpperCase()
							const prefixo = sexo === 'F' ? 'Dra.' : 'Dr.'
							const primeiroNome = nome.split(' ')[0]

							return `${i + 1}. ${prefixo} ${primeiroNome} | CRO: ${cro} | 📞 ${fone}`
						}).join('\n')

						await sock.sendMessage(sender, { text: `👥 *Lista de Clientes*\n━━━━━━━━━━━━━━━\n${list}` })
						return
					}

					// 2 PACIENTES
					if (text === '2') {
						const pacientes = await getSheetData(PLANILHA_CADASTROS, 'PACIENTES')
						if (pacientes.length === 0) {
							await sock.sendMessage(sender, { text: '❌ Nenhum paciente cadastrado.' })
							return
						}

						const list = pacientes.map((p, i) => {
							const nome = p.NOME_PAC || '—'
							const cli = p.CLIENTE || '—'
							return `${i + 1}. ${nome} (Cliente: ${cli})`
						}).join('\n')

						await sock.sendMessage(sender, { text: `🧑‍⚕️ *Lista de Pacientes*\n━━━━━━━━━━━━━━━\n${list}` })
						return
					}

					// 3 PRODUTOS
					if (text === '3') {
						const produtos = await getSheetData(PLANILHA_CADASTROS, 'PRODUTOS')
						if (produtos.length === 0) {
							await sock.sendMessage(sender, { text: '❌ Nenhum produto cadastrado.' })
							return
						}

						const list = produtos.map((p, i) => {
							const prod = p.PRODUTO || '—'
							const vlr = p.VLR_CAT || '—'
							const prazo = p.PRAZO || '—'
							return `${i + 1}. ${prod} | R$ ${vlr} | Prazo: ${prazo} dias`
						}).join('\n')

						await sock.sendMessage(sender, { text: `📦 *Lista de Produtos*\n━━━━━━━━━━━━━━━\n${list}` })
						return
					}

					// 4 CLIENTES A CADASTRAR
					if (text === '4') {
						const cliApr = await getSheetData(PLANILHA_CADASTROS, 'CLI_APR')
						if (cliApr.length === 0) {
							await sock.sendMessage(sender, { text: '✅ Nenhum cliente aguardando cadastro.' })
							return
						}

						const list = cliApr.map((c, i) => {
							const nome = c.RESPOSTA || '—'
							const fone = c.FONE_APR || '—'
							const data = c.DATA_REGISTRO || '—'
							return `${i + 1}. ${nome} | 📞 ${fone} | ⏱️ ${data}`
						}).join('\n')

						await sock.sendMessage(sender, { text: `📝 *Clientes a Cadastrar*\n━━━━━━━━━━━━━━━\n${list}` })
						return
					}

					// 5 ADMINISTRADORES
					if (text === '5') {
						const admins = await getSheetData(PLANILHA_CADASTROS, 'ADM_BOT')
						if (admins.length === 0) {
							await sock.sendMessage(sender, { text: '❌ Nenhum administrador cadastrado.' })
							return
						}

						const list = admins.map((a, i) => {
							const nome = a.NOME || '—'
							const fone = a.FONE_ADM || '—'
							return `${i + 1}. ${nome} | 📞 ${fone}`
						}).join('\n')

						await sock.sendMessage(sender, { text: `👨‍💼 *Administradores do Bot*\n━━━━━━━━━━━━━━━\n${list}` })
						return
					}
				}

				
				// === Submenu: Pedidos por Prazo (agrupado por cliente) ===
				if (estado.etapa === 'menu_admin_prazo') {
					if (text === '0') {
						await sock.sendMessage(sender, {
							text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
						})
						estado.etapa = 'menu_admin'
						return
					}

					const { atrasados, hojeList, futuro } = estado.pedidosPrazo || {}
					let lista = []
					let titulo = ''

					if (text === '1') { lista = atrasados; titulo = '⚠️ *PEDIDOS ATRASADOS*' }
					if (text === '2') { lista = hojeList; titulo = '⏰ *PEDIDOS PARA HOJE*' }
					if (text === '3') { lista = futuro; titulo = '✅ *PEDIDOS FUTUROS*' }

					if (!lista || lista.length === 0) {
						await sock.sendMessage(sender, { text: '❌ Nenhum pedido nesta categoria.' })
						return
					}

					// carrega clientes
					const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')

					// organiza pedidos por cliente
					const clientesMap = {}
					lista.forEach(p => {
						if (!clientesMap[p.CLIENTE]) clientesMap[p.CLIENTE] = []
						clientesMap[p.CLIENTE].push(p)
					})

					// ordena cada lista de pedidos pelo prazo mais antigo
					for (const cliente in clientesMap) {
						clientesMap[cliente].sort((a, b) => {
							const da = new Date(a.DT_PRAZO?.split('/').reverse().join('-'))
							const db = new Date(b.DT_PRAZO?.split('/').reverse().join('-'))
							return da - db
						})
					}

					// calcula total geral
					const total = lista.reduce((acc, p) => {
						let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
						return acc + (parseFloat(v) || 0)
					}, 0)
					const totalFormatado = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

					let msg = `${titulo}\n     _Total ${totalFormatado}_\n━━━━━━━━━━━━━━━\n`

					let contador = 1
					for (const clienteNome in clientesMap) {
						const listaCliente = clientesMap[clienteNome]

						// pega dados do cliente
						const cadastro = clientes.find(c => c.NOME_CLI === clienteNome)
						let tituloCliente = clienteNome
						if (cadastro) {
							const prefixo = cadastro.SEXO === 'F' ? '👩‍⚕️ Dra.' : '👨‍⚕️ Dr.'
							const primeiroNome = String(cadastro.NOME_CLI || '').split(' ')[0]
							tituloCliente = `${prefixo} *${primeiroNome}* CRO ${cadastro.CRO || ''}`
						}

						// soma total do cliente
						const totalCliente = listaCliente.reduce((acc, p) => {
							let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
							return acc + (parseFloat(v) || 0)
						}, 0)
						const totalClienteFmt = totalCliente.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

						msg += `${tituloCliente}\n💰 *Total: ${totalClienteFmt}*\n\n`

						listaCliente.forEach(p => {
							const nrPed = p.NR_PED
							const paciente = p.PACIENTE
							const prazo = p.DT_PRAZO
							const status = p.STATUS
							const valor = p.VLR_PED
							const obs = p.OBS

							// calcula atraso ou tempo até o prazo
							let prazoInfo = ''
							if (prazo) {
								const hoje = new Date()
								const prazoDate = new Date(prazo.split('/').reverse().join('-'))
								const diffDays = Math.ceil((prazoDate - hoje) / (1000 * 60 * 60 * 24))
								if (diffDays < 0) prazoInfo = ` - ${Math.abs(diffDays)} dias em atraso`
								if (diffDays === 0) prazoInfo = ` - vence hoje`
								if (diffDays > 0) prazoInfo = ` - em ${diffDays} dias`
							}

							msg += `${contador}️⃣ Pedido *${nrPed}*${prazoInfo}\n`
							msg += `*${status}*\n`
							msg += `   - Paciente: ${paciente}\n`
							msg += `   - Prazo: ${prazo}\n`
							msg += `   - Valor: ${valor}\n`
							if (obs) msg += `   - Obs: ${obs}\n`
							msg += `\n`
							contador++
						})

						msg += `━━━━━━━━━━━━━━━\n`
					}

					await sock.sendMessage(sender, { text: msg })
					return
				}

				// === Submenu: Pedidos por Status ===
				if (estado.etapa === 'menu_admin_status') {
					if (text === '0') {
						await sock.sendMessage(sender, {
							text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Voltar a este Menu
━━━━━━━━━━━━━━━`
						})
						estado.etapa = 'menu_admin'
						return
					}

					const index = parseInt(text) - 1
					if (!isNaN(index) && index >= 0 && index < (estado.statusList?.length || 0)) {
						const statusEscolhido = estado.statusList[index]

						const pedidos = await getSheetData(PLANILHA_PEDIDOS, 'PEDIDOS')
						const clientes = await getSheetData(PLANILHA_CADASTROS, 'CLIENTES')

						// filtra pedidos não pagos com esse status
						const pedidosStatus = pedidos.filter(
							p => p.STATUS === statusEscolhido && (!p.PAGO || String(p.PAGO).trim() === '')
						)

						if (pedidosStatus.length === 0) {
							await sock.sendMessage(sender, { text: `✅ Nenhum pedido *não pago* com status *${statusEscolhido}*.` })
							return
						}

						// agrupa por cliente
						const clientesMap = {}
						pedidosStatus.forEach(p => {
							if (!clientesMap[p.CLIENTE]) clientesMap[p.CLIENTE] = []
							clientesMap[p.CLIENTE].push(p)
						})

						let msg = `📊 Pedidos com Status: *${statusEscolhido}*\n━━━━━━━━━━━━━━━\n`

						let contador = 1
						for (const clienteNome in clientesMap) {
							const lista = clientesMap[clienteNome]

							// busca cadastro do cliente
							const cadastro = clientes.find(c => c.NOME_CLI === clienteNome)
							let titulo = clienteNome
							if (cadastro) {
								const prefixo = cadastro.SEXO === 'F' ? '👩‍⚕️ Dra.' : '👨‍⚕️ Dr.'
								const primeiroNome = String(cadastro.NOME_CLI || '').split(' ')[0]
								titulo = `${prefixo} ${primeiroNome} (CRO ${cadastro.CRO || ''})`
							}

							// soma total do cliente
							const totalCliente = lista.reduce((acc, p) => {
								let v = String(p.VLR_PED || '').trim().replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
								return acc + (parseFloat(v) || 0)
							}, 0)
							const totalClienteFmt = totalCliente.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

							msg += `${titulo}\n💰 Total: ${totalClienteFmt}\n\n`

							// ordena por prazo
							lista.sort((a, b) => {
								const da = new Date(a.DT_PRAZO?.split('/').reverse().join('-'))
								const db = new Date(b.DT_PRAZO?.split('/').reverse().join('-'))
								return da - db
							})

							lista.forEach(p => {
								// atraso/prazo
								let prazoInfo = ''
								if (p.DT_PRAZO) {
									const hoje = new Date()
									const prazoDate = new Date(p.DT_PRAZO.split('/').reverse().join('-'))
									const diffDays = Math.ceil((prazoDate - hoje) / (1000 * 60 * 60 * 24))
									if (diffDays < 0) prazoInfo = `${p.DT_PRAZO} - ${Math.abs(diffDays)} dia(s) em atraso`
									if (diffDays === 0) prazoInfo = `${p.DT_PRAZO} - vence hoje`
									if (diffDays > 0) prazoInfo = `${p.DT_PRAZO} - em ${diffDays} dia(s)`
								}

								msg += `${contador}️⃣ Pedido *${p.NR_PED}*\n`
								msg += `  - Paciente: ${p.PACIENTE}\n`
								msg += `  - Prazo: ${prazoInfo}\n`
								msg += `  - Valor: ${p.VLR_PED}\n`
								msg += `  - Terceir: ${p.CUST_TERC || '—'}\n`
								if (p.OBS) msg += `  - Obs: ${p.OBS}\n`
								msg += `\n`
								contador++
							})

							msg += `━━━━━━━━━━━━━━━\n`
						}

						await sock.sendMessage(sender, { text: msg })
						return
					} else {
						await sock.sendMessage(sender, { text: '❌ Opção inválida. Digite o número do status ou 0 para voltar.' })
					}
					return
				}

				// === Submenu: Pedidos por Cliente ===
				if (estado.etapa === 'menu_admin_pedidos') {
					if (text === '0') {
						await sock.sendMessage(sender, {
							text: `📋 *Menu Principal* 📋
━━━━━━━━━━━━━━━
1️⃣ Pedidos a Receber
2️⃣ Pedidos por Prazo
3️⃣ Pedidos por Status
4️⃣ Pedidos por Clientes
5️⃣ Consulta Cadastros
━━━━━━━━━━━━━━━
0️⃣ Para Voltar Neste Menu
━━━━━━━━━━━━━━━`
						})
						estado.etapa = 'menu_admin'
						return
					}

					const index = parseInt(text) - 1
					if (!isNaN(index) && index >= 0 && index < (estado.clientesPedidos?.length || 0)) {
						const clienteEscolhido = estado.clientesPedidos[index]
						const detalhes = await getPedidosCliente(clienteEscolhido, 'admin')
						await sock.sendMessage(sender, { text: detalhes })
					} else {
						await sock.sendMessage(sender, { text: '❌ Opção inválida. Digite o número do cliente ou 0 para voltar.' })
					}
					return
				}

// === Fluxo Dentista ===
if (estado?.perfil === 'dentista') {
    resetUserTimeout(sender)

    // Menu inicial do Dentista
    if (estado.etapa === 'inicio') {
        if (text === '1') {
            // Consultar Meus Pedidos
            const detalhes = await getPedidosCliente(
                estado.nome.replace(/^Dr\.?\s|Dra\.?\s/, '').trim(),
                'dentista'
            )
            await sock.sendMessage(sender, { text: detalhes })
            return
        }

        if (text === '2') {
            // Novo Pedido - inicia fluxo
            estado.etapa = 'novo_pedido_paciente'
            estado.pedido = inicializarPedido()
            await sock.sendMessage(sender, { text: '📝 Digite o *nome do PACIENTE*, ou *sair* para cancelar.' })
            return
        }

        if (text === '3') {
            await sock.sendMessage(sender, { text: '📞 Ok! Nossa equipe entrará em contato com você.' })
            delete userState[sender]
            return
        }

        await sock.sendMessage(sender, { text: '❌ Opção inválida. Escolha 1, 2 ou 3.' })
        return
    }

    // Etapa: Nome do paciente
    if (estado.etapa === 'novo_pedido_paciente') {
        if (text.toLowerCase() === 'sair') {
            delete estado.pedido
            estado.etapa = 'inicio'
            await sock.sendMessage(sender, { text: '❌ Pedido cancelado. Voltando ao menu.' })
            return
        }

        estado.pedido.paciente = text.trim()
        estado.etapa = 'novo_pedido_produto'

        const produtos = await getSheetData(PLANILHA_CADASTROS, 'PRODUTOS')
        const listaProdutos = produtos.map((p, i) =>
            `${i + 1}. ${p.PRODUTO} | R$ ${p.VLR_CAT} | Prazo: ${p.PRAZO} dias`
        ).join('\n')

        estado.produtos = produtos
        await sock.sendMessage(sender, { text: `📦 Escolha o *PRODUTO* (digite o número):\n\n${listaProdutos}\n\nOu digite *sair* para cancelar.` })
        return
    }

    // Etapa: Escolha do produto
    if (estado.etapa === 'novo_pedido_produto') {
        if (text.toLowerCase() === 'sair') {
            delete estado.pedido
            estado.etapa = 'inicio'
            await sock.sendMessage(sender, { text: '❌ Pedido cancelado. Voltando ao menu.' })
            return
        }

        const index = parseInt(text) - 1
        if (isNaN(index) || index < 0 || index >= estado.produtos.length) {
            await sock.sendMessage(sender, { text: '❌ Opção inválida. Digite o número do produto.' })
            return
        }

        estado.produtoEscolhido = estado.produtos[index]
        estado.etapa = 'novo_pedido_qtde'
        await sock.sendMessage(sender, { text: `📝 Digite a *quantidade* para o produto *${estado.produtoEscolhido.PRODUTO}*:` })
        return
    }

	// Etapa: Quantidade
	if (estado.etapa === 'novo_pedido_qtde') {
		const qtde = parseInt(text)
		if (isNaN(qtde) || qtde <= 0) {
			await sock.sendMessage(sender, { text: '❌ Quantidade inválida. Digite novamente.' })
			return
		}

		estado.itemAtual = {
			produto: estado.produtoEscolhido.PRODUTO,
			qtde,
			cor: '',
			obs: '',
			vlrCob: ''
		}

		// Busca valor do catálogo e grava em VLR_COB
		const valorCatalogo = await getValorCatalogo(estado.produtoEscolhido.PRODUTO)
		estado.itemAtual.vlrCob = valorCatalogo

		estado.etapa = 'novo_pedido_cor'
		await sock.sendMessage(sender, { text: '🎨 Digite a *COR* para este item, ou *sair* para cancelar.' })
		return
	}
	// Etapa: Cor
	if (estado.etapa === 'novo_pedido_cor') {
		if (text.toLowerCase() === 'sair') {
			delete estado.itemAtual
			estado.etapa = 'inicio'
			await sock.sendMessage(sender, { text: '❌ Pedido cancelado. Voltando ao menu.' })
			return
		}

		estado.itemAtual.cor = text.trim()
		estado.etapa = 'novo_pedido_menu_item'

		await sock.sendMessage(sender, {
			text: `✅ Produto *${estado.itemAtual.produto}* (${estado.itemAtual.qtde}x | Cor: ${estado.itemAtual.cor}) adicionado.\n\nEscolha uma opção:\n1️⃣ Incluir Observação\n2️⃣ Incluir Outro Produto\n3️⃣ Concluir Pedido\n4️⃣ Cancelar Pedido`
		})
		return
	}

    // Etapa: Menu de opções após adicionar item
    if (estado.etapa === 'novo_pedido_menu_item') {
        if (text === '1') {
            estado.etapa = 'novo_pedido_obs'
            await sock.sendMessage(sender, { text: '✍️ Digite a *observação* para este item:' })
            return
        }
        if (text === '2') {
            estado.pedido.itens.push(estado.itemAtual)
            delete estado.itemAtual
            estado.etapa = 'novo_pedido_produto'

            const produtos = await getSheetData(PLANILHA_CADASTROS, 'PRODUTOS')
            const listaProdutos = produtos.map((p, i) =>
                `${i + 1}. ${p.PRODUTO} | R$ ${p.VLR_CAT} | Prazo: ${p.PRAZO} dias`
            ).join('\n')

            estado.produtos = produtos
            await sock.sendMessage(sender, { text: `📦 Escolha o *PRODUTO* (digite o número):\n\n${listaProdutos}` })
            return
        }
        if (text === '3') {
            estado.pedido.itens.push(estado.itemAtual)
            delete estado.itemAtual

            const nrPed = await salvarPedido(
                estado.nome.replace(/^Dr\.?\s|Dra\.?\s/, '').trim(),
                estado.pedido
            )

            await sock.sendMessage(sender, { text: `✅ Pedido *${nrPed}* registrado com sucesso!` })
            estado.etapa = 'inicio'
            delete estado.pedido
            return
        }
        if (text === '4') {
            delete estado.pedido
            delete estado.itemAtual
            estado.etapa = 'inicio'
            await sock.sendMessage(sender, { text: '❌ Pedido cancelado. Voltando ao menu.' })
            return
        }

        await sock.sendMessage(sender, { text: '❌ Opção inválida. Escolha 1, 2, 3 ou 4.' })
        return
    }

    // Etapa: Observação
    if (estado.etapa === 'novo_pedido_obs') {
        estado.itemAtual.obs = text.trim()
        estado.etapa = 'novo_pedido_menu_item'
        await sock.sendMessage(sender, {
            text: `✅ Observação adicionada ao produto *${estado.itemAtual.produto}*.\n\nEscolha uma opção:\n1️⃣ Incluir Observação\n2️⃣ Incluir Outro Produto\n3️⃣ Concluir Pedido\n4️⃣ Cancelar Pedido`
        })
        return
    }
}
// 📖 Link do catálogo (encurtado no bit.ly)
const CATALOGO_LINK = 'https://bit.ly/Aura-Catalogo'

// === Fluxo Desconhecido ===
if (estado?.perfil === 'desconhecido') {
    resetUserTimeout(sender)
    if (estado.etapa === 'menu_inicial') {
        if (text === '1') {
            await sock.sendMessage(sender, { text: '✍️ Me informe seu *Nome e CRO*, ou digite *sair* para falar com alguém.' })
            estado.etapa = 'aguardando_nome_cro'
            return
        } else if (text === '2') {
            await sock.sendMessage(sender, { text: '📞 Em breve alguém entrará em contato com você.' })
            delete userState[sender]
            return
        }
    }

	if (estado.etapa === 'aguardando_nome_cro') {
		if (text.toLowerCase() === 'sair') {
			await sock.sendMessage(sender, { text: '📞 Ok! Um atendente entrará em contato com você.' })
			delete userState[sender]
			return
		}

		if (validarNomeCRO(text)) {
			const numero = normalizarNumero(sender)
			await salvarDentistaAproximacao(numero, text)

			// ✅ Envia a imagem do catálogo direto do servidor
			const imageBuffer = fs.readFileSync('./media/aura.png')

			await sock.sendMessage(sender, {
				image: imageBuffer,
				caption: `✅ Obrigado pela sua resposta! Vamos validar suas informações e, caso necessário, entraremos em contato.\n\n📖 Enquanto isso, acesse nosso *Catálogo de Trabalho*:\n${CATALOGO_LINK}`
			})

			delete userState[sender]
			return
		} else {
			// 👇 Trata quando o nome + CRO é inválido
			await sock.sendMessage(sender, {
				text: '❌ Formato inválido. Envie novamente: *Nome e CRO* (mínimo 4 letras para o nome e 3 dígitos para o CRO).'
			})
			return
		}
	}

} // fecha fluxo Desconhecido

}) // fecha messages.upsert
} // fecha startBot

startBot()
