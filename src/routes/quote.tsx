                <Row label="Cash-down" value={formatMoney(o.deposit)} bold />
                <Row label="Deposit %" value={`${o.depositPct.toFixed(1)}%`} />
                <Row label="Term" value={`${o.termMonths} mo`} bold />
                <Row label="Residual %" value={`${o.residualPct.toFixed(1)}%`} />
                <Row label="Int. rate" value={`${o.ratePct.toFixed(2)}%`} />
