//! Contrôle synthétique du courtier contre une API réelle sur loopback.
//! Les identifiants de test arrivent uniquement sur stdin, jamais en arguments.
use caissepro_session::{
    Broker, Draft, Error, ExpenseDetails, ReceiptDetails, SaveDraft, SupportingDocument,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    base: String,
    deployment: String,
    company_code: String,
    email: String,
    password: String,
    renewed_password: String,
}

async fn run(input: Input) -> Result<(), Box<dyn std::error::Error>> {
    let admin = Broker::new(&input.base, &input.deployment, Uuid::new_v4(), true)?;
    let first = admin
        .login(
            input.company_code.clone(),
            input.email.clone(),
            Zeroizing::new(input.password.clone()),
        )
        .await?;
    assert!(first.profile.as_ref().unwrap().user.must_change_password);
    let changed = admin
        .change_password(
            Zeroizing::new(input.password.clone()),
            Zeroizing::new(input.renewed_password.clone()),
            Some(first.generation),
        )
        .await?;
    assert_eq!(changed.state, "anonymous");
    let administrator = admin
        .login(
            input.company_code.clone(),
            input.email,
            Zeroizing::new(input.renewed_password.clone()),
        )
        .await?;
    let profile = administrator.profile.as_ref().unwrap();
    let agency = profile.agencies[0].id;
    let cash = profile.cash_registers[0].id;
    let email = format!("{}@example.test", Uuid::new_v4());
    let created = admin.admin("create", Some(json!({"email":email,"displayName":"Caissier synthétique","initialPassword":input.password,"access":{"roles":["CASHIER"],"agencyIds":[agency],"cashRegisterIds":[cash],"active":true}})), Some(administrator.generation)).await?;
    let new_agency = Uuid::new_v4();
    let new_cash = Uuid::new_v4();
    admin
        .cash_action(
            "create-agency",
            Some(json!({"id":new_agency,"code":"ANNEXE","name":"Agence annexe synthétique"})),
            Some(administrator.generation),
        )
        .await?;
    admin.cash_action("create",Some(json!({"id":new_cash,"agencyId":new_agency,"code":"ANNEXE","name":"Caisse annexe synthétique","authorizedUserIds":[]})),Some(administrator.generation)).await?;
    admin.cash_action("update",Some(json!({"id":new_cash,"data":{"expectedVersion":1,"name":"Caisse annexe inactive","active":false}})),Some(administrator.generation)).await?;
    assert_eq!(
        admin
            .cash_action("configuration", None, Some(administrator.generation))
            .await?["registers"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    admin.expense_action("configure",Some(json!({"currency":"USD","data":{"expectedVersion":null,"requireEvidence":true,"limits":[{"role":"CASHIER","action":"REQUEST","maximum":"1000.00"},{"role":"CASHIER","action":"PAY","maximum":"1000.00"},{"role":"DIRECTOR","action":"APPROVE","maximum":"1000.00"}]}})),Some(administrator.generation)).await?;
    let director_email = format!("{}@example.test", Uuid::new_v4());
    admin.admin("create",Some(json!({"email":director_email,"displayName":"Directeur synthétique","initialPassword":input.password,"access":{"roles":["DIRECTOR"],"agencyIds":[agency],"cashRegisterIds":[cash],"active":true}})),Some(administrator.generation)).await?;
    let director = Broker::new(&input.base, &input.deployment, Uuid::new_v4(), true)?;
    let first = director
        .login(
            input.company_code.clone(),
            director_email.clone(),
            Zeroizing::new(input.password.clone()),
        )
        .await?;
    director
        .change_password(
            Zeroizing::new(input.password.clone()),
            Zeroizing::new(input.renewed_password.clone()),
            Some(first.generation),
        )
        .await?;
    let director_session = director
        .login(
            input.company_code.clone(),
            director_email,
            Zeroizing::new(input.renewed_password.clone()),
        )
        .await?;
    let cashier = Broker::new(&input.base, &input.deployment, Uuid::new_v4(), true)?;
    let first = cashier
        .login(
            input.company_code.clone(),
            email.clone(),
            Zeroizing::new(input.password.clone()),
        )
        .await?;
    cashier
        .change_password(
            Zeroizing::new(input.password),
            Zeroizing::new(input.renewed_password.clone()),
            Some(first.generation),
        )
        .await?;
    let session = cashier
        .login(
            input.company_code,
            email,
            Zeroizing::new(input.renewed_password.clone()),
        )
        .await?;
    let generation = Some(session.generation);
    assert!(matches!(
        cashier.admin("users", None, generation).await,
        Err(Error::Forbidden)
    ));
    let balances = cashier.balances(generation).await?;
    let rows = balances["data"]["balances"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| row["balance"] == "0.00"));
    let now = Utc::now();
    let draft = Draft {
        expense_details: None,
        receipt_details: Some(ReceiptDetails {
            provenance: "Client synthétique".into(),
            category: "VENTE".into(),
            reference: "TEST-INTEGRATION".into(),
            supporting_document: None,
        }),
        id: Uuid::new_v4(),
        kind: "receipt".into(),
        currency: "USD".into(),
        amount: "12.34".into(),
        description: "Encaissement synthétique en base de test isolée".into(),
        created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        expires_at: (now + chrono::Duration::minutes(10))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    cashier.save_draft(
        SaveDraft {
            draft,
            agency_id: agency,
            cash_register_id: Some(cash),
            expected_version: None,
        },
        generation,
    )?;
    let results = cashier.synchronize(generation).await?;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, "accepted-as-draft");
    assert!(results[0].server_id.is_some());
    assert_eq!(results[0].server_version, Some(1));
    assert_eq!(results[0].source_state.as_deref(), Some("draft"));
    let sync_status = cashier.synchronization_status(generation)?;
    assert_eq!(sync_status["counts"]["synced"], 1);
    assert!(sync_status["lastSuccessfulAt"].is_string());
    assert!(sync_status["cacheUpdatedAt"].is_string());
    assert!(cashier.synchronize(generation).await?.is_empty());
    let before = cashier.cash_catalog(generation).await?;
    assert!(before["data"]["items"][0]["funds"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["balance"] == "0.00"));
    cashier
        .cash_action("open", Some(json!({"id":cash})), generation)
        .await?;
    let pending = cashier.cash_action("pending", None, generation).await?;
    let source = &pending["items"][0];
    let recovered = Broker::new(&input.base, &input.deployment, Uuid::new_v4(), true)?;
    assert_eq!(recovered.status()?.state, "anonymous");
    let current_profile = session.profile.as_ref().unwrap();
    let recovery = recovered
        .login(
            current_profile.company.code.clone(),
            current_profile.user.email.clone(),
            Zeroizing::new(input.renewed_password.clone()),
        )
        .await?;
    let recovery_generation = Some(recovery.generation);
    assert!(recovered.drafts(recovery_generation)?.is_empty());
    let manifest = recovered
        .synchronization_action("manifest", None, recovery_generation)
        .await?;
    assert_eq!(manifest["total"], 1);
    assert_eq!(manifest["items"][0]["serverId"], source["id"]);
    let resumed = recovered
        .synchronization_action(
            "restore",
            Some(json!({"id":source["clientDraftId"]})),
            recovery_generation,
        )
        .await?;
    assert_eq!(resumed["serverId"], source["id"]);
    assert_eq!(
        resumed["originalCreatedAt"],
        manifest["items"][0]["createdAt"]
    );
    assert_eq!(resumed["state"], "synced");
    assert!(recovered.synchronize(recovery_generation).await?.is_empty());
    let journal = recovered
        .synchronization_action("events", None, recovery_generation)
        .await?;
    assert!(journal["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["stage"] == "SUCCESS"));
    let restored = recovered
        .cash_action(
            "restore",
            Some(json!({"id":source["id"]})),
            recovery_generation,
        )
        .await?;
    assert_eq!(restored["draft"]["id"], source["clientDraftId"]);
    assert!(matches!(
        cashier
            .cash_action(
                "confirm",
                Some(
                    json!({"id":source["id"],"expectedVersion":source["version"],"received":false})
                ),
                generation
            )
            .await,
        Err(Error::InvalidInput)
    ));
    let receipt = recovered
        .cash_action(
            "confirm",
            Some(json!({"id":source["id"],"expectedVersion":source["version"],"received":true})),
            recovery_generation,
        )
        .await?;
    let replay = cashier
        .cash_action(
            "confirm",
            Some(json!({"id":source["id"],"expectedVersion":source["version"],"received":true})),
            generation,
        )
        .await?;
    assert_eq!(receipt["id"], replay["id"]);
    assert_eq!(receipt["amount"], "12.34");
    assert!(receipt["number"].as_str().unwrap().starts_with("REC-"));
    cashier.cash_action("pending", None, generation).await?;
    assert_eq!(cashier.drafts(generation)?[0].state, "confirmed");
    assert!(cashier.synchronize(generation).await?.is_empty());
    let after = cashier.cash_catalog(generation).await?;
    let funds = after["data"]["items"][0]["funds"].as_array().unwrap();
    assert_eq!(
        funds.iter().find(|f| f["currency"] == "USD").unwrap()["balance"],
        "12.34"
    );
    assert_eq!(
        funds.iter().find(|f| f["currency"] == "CDF").unwrap()["balance"],
        "0.00"
    );
    assert_eq!(
        cashier
            .cash_action("history", Some(json!({"currency":"USD"})), generation)
            .await?["total"],
        1
    );
    let now = Utc::now();
    let expense_client = Uuid::new_v4();
    cashier.save_draft(
        SaveDraft {
            draft: Draft {
                id: expense_client,
                kind: "expense-request".into(),
                currency: "USD".into(),
                amount: "2.34".into(),
                description: "Dépense synthétique avec approbation préalable".into(),
                created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                expires_at: (now + chrono::Duration::minutes(10))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                receipt_details: None,
                expense_details: Some(ExpenseDetails {
                    beneficiary: "Fournisseur synthétique".into(),
                    reference: "FACTURE-TEST".into(),
                    documents: vec![SupportingDocument {
                        file_name: "facture.pdf".into(),
                        mime_type: "application/pdf".into(),
                        data_base64: "JVBERi0xLjQK".into(),
                    }],
                }),
            },
            agency_id: agency,
            cash_register_id: Some(cash),
            expected_version: None,
        },
        generation,
    )?;
    let expense_sync = cashier.synchronize(generation).await?;
    assert_eq!(expense_sync.len(), 1);
    assert_eq!(
        cashier.expense_action("list", None, generation).await?["total"],
        0
    );
    let pending = cashier.expense_action("drafts", None, generation).await?;
    let source = &pending["items"][0];
    assert!(source["expenseRequestId"].is_null());
    let expense = cashier
        .expense_action(
            "submit",
            Some(json!({"id":source["id"],"expectedVersion":source["version"],"submitted":true})),
            generation,
        )
        .await?;
    assert_eq!(expense["state"], "PENDING");
    assert!(cashier.synchronize(generation).await?.is_empty());
    let approved=director.expense_action("decide",Some(json!({"id":expense["id"],"data":{"expectedVersion":expense["version"],"decision":"APPROVE","reason":"Justificatif vérifié"}})),Some(director_session.generation)).await?;
    assert_eq!(approved["state"], "APPROVED");
    let reserved = cashier.cash_catalog(generation).await?;
    let fund = reserved["data"]["items"][0]["funds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["currency"] == "USD")
        .unwrap();
    assert_eq!(fund["balance"], "12.34");
    assert_eq!(fund["reserved"], "2.34");
    assert_eq!(fund["available"], "10.00");
    assert!(matches!(
        cashier
            .expense_action(
                "pay",
                Some(
                    json!({"id":expense["id"],"expectedVersion":approved["version"],"paid":false})
                ),
                generation
            )
            .await,
        Err(Error::InvalidInput)
    ));
    let voucher = cashier
        .expense_action(
            "pay",
            Some(json!({"id":expense["id"],"expectedVersion":approved["version"],"paid":true})),
            generation,
        )
        .await?;
    assert_eq!(voucher["amount"], "2.34");
    assert!(voucher["number"].as_str().unwrap().starts_with("BON-"));
    let replay = recovered
        .expense_action(
            "pay",
            Some(json!({"id":expense["id"],"expectedVersion":approved["version"],"paid":true})),
            recovery_generation,
        )
        .await?;
    assert_eq!(voucher, replay);
    let final_cash = cashier.cash_catalog(generation).await?;
    let fund = final_cash["data"]["items"][0]["funds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["currency"] == "USD")
        .unwrap();
    assert_eq!(fund["balance"], "10.00");
    assert_eq!(fund["reserved"], "0.00");
    assert_eq!(
        cashier
            .expense_action("voucher", Some(json!({"id":voucher["id"]})), generation)
            .await?,
        voucher
    );
    // Étape 8 : statistiques et fichiers réels, sans jeton ni calcul financier côté React.
    let report = cashier
        .report_action("snapshot", Some(json!({"period":"month"})), generation)
        .await?;
    assert_eq!(
        report["totals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["currency"] == "USD")
            .unwrap()["balance"],
        "10.00"
    );
    assert_eq!(report["company"]["code"], profile.company.code);
    for format in ["pdf", "xlsx"] {
        use base64::Engine;
        let file = cashier
            .report_action(format, Some(report["query"].clone()), generation)
            .await?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file["dataBase64"].as_str().unwrap())?;
        assert!(bytes.starts_with(if format == "pdf" { b"%PDF-" } else { b"PK" }));
    }
    // Étape 7 : deux opérateurs distincts et deux caisses, transport réel sans jeton React.
    let destination_cash = Uuid::new_v4();
    admin.cash_action("create",Some(json!({"id":destination_cash,"agencyId":agency,"code":"TRANSFERTS","name":"Destination des transferts","authorizedUserIds":[]})),Some(administrator.generation)).await?;
    let mut operators = Vec::new();
    for name in ["Remettant synthétique", "Réceptionnaire synthétique"] {
        let email = format!("{}@example.test", Uuid::new_v4());
        admin.admin("create",Some(json!({"email":email,"displayName":name,"initialPassword":input.renewed_password,"access":{"roles":["FINANCE_MANAGER"],"agencyIds":[agency],"cashRegisterIds":[cash,destination_cash],"active":true}})),Some(administrator.generation)).await?;
        let broker = Broker::new(&input.base, &input.deployment, Uuid::new_v4(), true)?;
        let first = broker
            .login(
                profile.company.code.clone(),
                email.clone(),
                Zeroizing::new(input.renewed_password.clone()),
            )
            .await?;
        let next_password = format!("Native-test-{}", Uuid::new_v4());
        broker
            .change_password(
                Zeroizing::new(input.renewed_password.clone()),
                Zeroizing::new(next_password.clone()),
                Some(first.generation),
            )
            .await?;
        let session = broker
            .login(
                profile.company.code.clone(),
                email,
                Zeroizing::new(next_password),
            )
            .await?;
        operators.push((broker, session));
    }
    let (sender, sender_view) = &operators[0];
    let (receiver, receiver_view) = &operators[1];
    let sender_generation = Some(sender_view.generation);
    let receiver_generation = Some(receiver_view.generation);
    sender
        .cash_action(
            "open",
            Some(json!({"id":destination_cash})),
            sender_generation,
        )
        .await?;
    for (destination_currency, amount, rate, rate_source) in [
        ("USD", "2.00", "", ""),
        ("CDF", "1.00", "2800", "Guichet synthétique"),
    ] {
        let id = Uuid::new_v4();
        sender.synchronization_action("buffer-save",Some(json!({"id":id,"kind":"transfer","agencyId":agency,"cashRegisterId":cash,"expectedLocalVersion":null,"fields":{"amount":amount,"currency":"USD","destinationCurrency":destination_currency,"destinationCashRegisterId":destination_cash.to_string(),"rate":rate,"rateSource":rate_source,"description":"Transfert intégré synthétique"}})),sender_generation).await?;
        let draft = sender
            .transfer_action("send", Some(json!({"id":id})), sender_generation)
            .await?;
        assert_eq!(draft["state"], "DRAFT");
        let handed = sender
            .transfer_action(
                "handover",
                Some(json!({"id":id,"expectedVersion":1,"handedOver":true,"rateValidated":true})),
                sender_generation,
            )
            .await?;
        assert_eq!(handed["state"], "HANDED_OVER");
        let posted = receiver
            .transfer_action(
                "receive",
                Some(json!({"id":id,"expectedVersion":2,"received":true})),
                receiver_generation,
            )
            .await?;
        assert_eq!(posted["state"], "RECEIVED");
        assert!(posted["slip"]["number"]
            .as_str()
            .unwrap()
            .starts_with("TRF-"));
        let replay = receiver
            .transfer_action(
                "receive",
                Some(json!({"id":id,"expectedVersion":2,"received":true})),
                receiver_generation,
            )
            .await?;
        assert_eq!(posted, replay);
    }
    let balances = receiver.cash_catalog(receiver_generation).await?;
    let registers = balances["data"]["items"].as_array().unwrap();
    let funds = registers
        .iter()
        .find(|r| r["id"] == cash.to_string())
        .unwrap()["funds"]
        .as_array()
        .unwrap();
    assert_eq!(
        funds.iter().find(|f| f["currency"] == "USD").unwrap()["balance"],
        "7.00"
    );
    let target = registers
        .iter()
        .find(|r| r["id"] == destination_cash.to_string())
        .unwrap()["funds"]
        .as_array()
        .unwrap();
    assert_eq!(
        target.iter().find(|f| f["currency"] == "USD").unwrap()["balance"],
        "2.00"
    );
    assert_eq!(
        target.iter().find(|f| f["currency"] == "CDF").unwrap()["balance"],
        "2800.00"
    );
    for (broker, session) in operators {
        broker.logout(Some(session.generation)).await?;
    }
    let locked = cashier.lock(generation).await?;
    // Cette requête ne s'exécute qu'après déverrouillage ci-dessous.
    assert_eq!(locked.state, "locked");
    assert!(matches!(cashier.drafts(generation), Err(Error::Locked)));
    let unlocked = cashier
        .unlock(Zeroizing::new(input.renewed_password), generation)
        .await?;
    assert_eq!(unlocked.state, "online");
    let generation = Some(unlocked.generation);
    assert_eq!(
        cashier
            .cash_action(
                "history",
                Some(json!({"search":"é".repeat(160)})),
                generation
            )
            .await?["total"],
        0
    );
    let retained = cashier.drafts(generation)?;
    assert_eq!(retained.len(), 2);
    assert_eq!(
        retained
            .iter()
            .find(|r| r.draft.kind == "receipt")
            .unwrap()
            .state,
        "confirmed"
    );
    let submitted = retained
        .iter()
        .find(|r| r.draft.kind == "expense-request")
        .unwrap();
    assert_eq!(submitted.state, "submitted");
    assert_eq!(
        submitted.submitted_expense_id.unwrap().to_string(),
        expense["id"].as_str().unwrap()
    );
    recovered.logout(recovery_generation).await?;
    admin.admin("access", Some(json!({"userId":created["id"],"expectedVersion":created["version"],"access":{"roles":["AUDITOR"],"agencyIds":[agency],"cashRegisterIds":[cash],"active":true}})), Some(administrator.generation)).await?;
    assert!(matches!(
        cashier.synchronize(generation).await,
        Err(Error::Credentials)
    ));
    assert_eq!(cashier.status()?.state, "anonymous");
    assert!(matches!(
        cashier.drafts(generation),
        Err(Error::SessionChanged)
    ));
    assert!(admin
        .admin("logs", None, Some(administrator.generation))
        .await?
        .as_array()
        .is_some_and(|rows| !rows.is_empty()));
    assert_eq!(
        admin.logout(Some(administrator.generation)).await?.state,
        "anonymous"
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    // Ne jamais imprimer une valeur d'assertion susceptible de contenir un secret.
    std::panic::set_hook(Box::new(|info| {
        if let Some(location) = info.location() {
            eprintln!("CAISSEPRO_AUTH_CONTRACT_PANIC_LINE_{}", location.line());
        }
    }));
    let mut data = Zeroizing::new(String::new());
    let result = async {
        io::stdin().take(8192).read_to_string(&mut data)?;
        let input = serde_json::from_str(&data)?;
        run(input).await
    }
    .await;
    if let Err(error) = result {
        let code = error
            .downcast_ref::<Error>()
            .map(ToString::to_string)
            .unwrap_or_else(|| "CONTRACT_CHECK_FAILED".into());
        eprintln!("CAISSEPRO_AUTH_CONTRACT_FAILED:{code}");
        std::process::exit(1);
    }
    println!("CAISSEPRO_AUTH_CONTRACT_PASSED");
}
