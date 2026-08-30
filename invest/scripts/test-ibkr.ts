/**
 * Tests del parser de Flex de Interactive Brokers.
 * Sin red: se le pasan XML de ejemplo con la forma real que devuelve IBKR.
 *
 *   npm run test:ibkr
 */
import {
  FlexError,
  isDividend,
  mapAssetClass,
  parseFlexDate,
  parseFlexStatement,
} from "../src/lib/brokers/ibkr";

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail = "") {
  checks++;
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FALLO ${label}${detail ? ": " + detail : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  check(
    actual === expected,
    label,
    `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`,
  );
}

/* Una sola operacion: fast-xml-parser devuelve objeto, no array. */
const SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Cartera" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U1234567" fromDate="20240101" toDate="20240630" period="LastNMonths">
      <Trades>
        <Trade accountId="U1234567" symbol="AAPL" conid="265598" assetCategory="STK"
               currency="USD" tradeDate="20240315" dateTime="20240315;103012"
               buySell="BUY" quantity="10" tradePrice="172.5" tradeMoney="1725"
               ibCommission="-1.05" transactionID="55512345" openCloseIndicator="O" />
      </Trades>
      <OpenPositions>
        <OpenPosition symbol="AAPL" conid="265598" assetCategory="STK" currency="USD"
                      position="10" markPrice="180.20" positionValue="1802"
                      costBasisPrice="172.605" costBasisMoney="1726.05" />
      </OpenPositions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

/* Varias operaciones, venta, opcion descartada, dividendo y retencion. */
const MULTI = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="Cartera" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U7654321" fromDate="20240101" toDate="20241231">
      <Trades>
        <Trade symbol="MSFT" assetCategory="STK" currency="USD" tradeDate="20240110"
               buySell="BUY" quantity="5" tradePrice="400.10" ibCommission="-1.00"
               transactionID="1001" />
        <Trade symbol="MSFT" assetCategory="STK" currency="USD" tradeDate="20240220"
               buySell="SELL" quantity="-2" tradePrice="420.00" ibCommission="-1.00"
               transactionID="1002" />
        <Trade symbol="VWCE" assetCategory="FUND" currency="EUR" tradeDate="20240301"
               buySell="BUY" quantity="12" tradePrice="112.4" ibCommission="-1.50"
               transactionID="1003" />
        <Trade symbol="SPY   240419C00500000" assetCategory="OPT" currency="USD"
               tradeDate="20240315" buySell="BUY" quantity="1" tradePrice="3.2"
               ibCommission="-0.65" transactionID="1004" />
      </Trades>
      <OpenPositions>
        <OpenPosition symbol="MSFT" assetCategory="STK" currency="USD"
                      position="3" costBasisPrice="400.30" />
        <OpenPosition symbol="VWCE" assetCategory="FUND" currency="EUR"
                      position="12" costBasisPrice="112.525" />
      </OpenPositions>
      <CashTransactions>
        <CashTransaction symbol="MSFT" type="Dividends" amount="4.50" currency="USD"
                         dateTime="20240314" transactionID="2001"
                         description="MSFT(US5949181045) CASH DIVIDEND" />
        <CashTransaction symbol="MSFT" type="Withholding Tax" amount="-0.68" currency="USD"
                         dateTime="20240314" transactionID="2002"
                         description="MSFT WITHHOLDING" />
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

const TOKEN_EXPIRED = `<FlexStatementResponse timestamp="28 August, 2026 10:37 AM EDT">
  <Status>Fail</Status>
  <ErrorCode>1012</ErrorCode>
  <ErrorMessage>Token has expired.</ErrorMessage>
</FlexStatementResponse>`;

const GENERATING = `<FlexStatementResponse timestamp="28 August, 2026 10:37 AM EDT">
  <Status>Fail</Status>
  <ErrorCode>1009</ErrorCode>
  <ErrorMessage>Statement generation in progress.</ErrorMessage>
</FlexStatementResponse>`;

console.log("\n1. Un solo elemento (el parser lo da como objeto, no array)");
{
  const st = parseFlexStatement(SINGLE);
  eq(st.accountId, "U1234567", "accountId");
  eq(st.trades.length, 1, "una operacion");
  const t = st.trades[0];
  eq(t.symbol, "AAPL", "symbol");
  eq(t.side, "buy", "side");
  eq(t.quantity, 10, "cantidad");
  eq(t.price, 172.5, "precio");
  eq(t.commission, 1.05, "comision en positivo");
  eq(t.transactionId, "55512345", "transactionID para dedupe");
  eq(st.positions.length, 1, "una posicion abierta");
  eq(st.positions[0].costBasisPrice, 172.605, "coste medio de IBKR");
}

console.log("\n2. Fecha con hora, sin hora, y formato con separadores");
{
  eq(parseFlexDate("20240315;103012"), Date.UTC(2024, 2, 15, 10, 30, 12), "con ;HHMMSS");
  eq(parseFlexDate("20240315"), Date.UTC(2024, 2, 15, 12, 0, 0), "sin hora, mediodia UTC");
  eq(parseFlexDate("20240315 10:30:00"), Date.UTC(2024, 2, 15, 10, 30, 0), "con espacio y :");
  check(Number.isNaN(parseFlexDate("")), "vacio da NaN");
  check(Number.isNaN(parseFlexDate("no es fecha")), "basura da NaN");
}

console.log("\n3. Varias operaciones, venta, y opcion descartada");
{
  const st = parseFlexStatement(MULTI);
  eq(st.trades.length, 3, "3 operaciones soportadas (la opcion se descarta)");
  eq(st.skipped.length, 1, "1 fila descartada");
  eq(st.skipped[0].assetCategory, "OPT", "la descartada es la opcion");

  const sell = st.trades.find((t) => t.transactionId === "1002")!;
  eq(sell.side, "sell", "buySell=SELL detectado");
  eq(sell.quantity, 2, "cantidad en positivo pese al -2 del XML");

  const fund = st.trades.find((t) => t.transactionId === "1003")!;
  eq(fund.currency, "EUR", "moneda no USD respetada");
  eq(mapAssetClass(fund.assetCategory), "etf", "FUND se mapea a etf");
}

console.log("\n4. Dividendos si, retenciones no");
{
  const st = parseFlexStatement(MULTI);
  eq(st.cash.length, 2, "dos movimientos de efectivo leidos");
  const dividends = st.cash.filter(isDividend);
  eq(dividends.length, 1, "solo uno cuenta como dividendo");
  eq(dividends[0].amount, 4.5, "importe del dividendo");
  check(
    !st.cash.filter(isDividend).some((c) => c.amount < 0),
    "ninguna retencion se cuela como dividendo",
  );
}

console.log("\n5. Posiciones abiertas para reconciliar");
{
  const st = parseFlexStatement(MULTI);
  eq(st.positions.length, 2, "dos posiciones");
  const msft = st.positions.find((p) => p.symbol === "MSFT")!;
  eq(msft.quantity, 3, "IBKR dice 3 aunque los trades sumen 5-2=3");
}

console.log("\n6. Errores de IBKR se traducen a mensajes utiles");
{
  try {
    parseFlexStatement(TOKEN_EXPIRED);
    check(false, "deberia lanzar con token caducado");
  } catch (e) {
    check(e instanceof FlexError, "lanza FlexError");
    eq((e as FlexError).code, "1012", "codigo 1012");
    check(
      /caducado/i.test((e as Error).message),
      "el mensaje explica que el token caduco",
      (e as Error).message,
    );
  }

  try {
    parseFlexStatement(GENERATING);
    check(false, "deberia lanzar mientras se genera");
  } catch (e) {
    eq((e as FlexError).code, "1009", "codigo 1009 para reintentar");
  }
}

console.log("\n7. Mapeo de categorias de activo");
{
  eq(mapAssetClass("STK"), "equity", "STK");
  eq(mapAssetClass("FUND"), "etf", "FUND");
  eq(mapAssetClass("CRYPTO"), "crypto", "CRYPTO");
  eq(mapAssetClass("OPT"), null, "OPT no soportado");
  eq(mapAssetClass("FUT"), null, "FUT no soportado");
  eq(mapAssetClass("CASH"), null, "CASH (forex) no soportado");
}

console.log(
  `\n${failures === 0 ? "TODO OK" : "HAY FALLOS"}: ${checks - failures}/${checks} comprobaciones\n`,
);
process.exit(failures === 0 ? 0 : 1);
