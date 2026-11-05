//! Contrôle synthétique du courtier contre une API réelle sur loopback.
//! Les identifiants de test arrivent uniquement sur stdin, jamais en arguments.
use caissepro_session::{Broker, Draft, Error, SaveDraft};
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
        id: Uuid::new_v4(),
        kind: "receipt".into(),
        currency: "USD".into(),
        amount: "12.34".into(),
        description: "Contrôle synthétique, aucun encaissement confirmé".into(),
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
    assert!(cashier.synchronize(generation).await?.is_empty());
    let locked = cashier.lock(generation).await?;
    assert_eq!(locked.state, "locked");
    assert!(matches!(cashier.drafts(generation), Err(Error::Locked)));
    let unlocked = cashier
        .unlock(Zeroizing::new(input.renewed_password), generation)
        .await?;
    assert_eq!(unlocked.state, "online");
    let generation = Some(unlocked.generation);
    assert_eq!(cashier.drafts(generation)?.len(), 1);
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
    let mut data = Zeroizing::new(String::new());
    let result = async {
        io::stdin().take(8192).read_to_string(&mut data)?;
        let input = serde_json::from_str(&data)?;
        run(input).await
    }
    .await;
    if result.is_err() {
        eprintln!("CAISSEPRO_AUTH_CONTRACT_FAILED");
        std::process::exit(1);
    }
    println!("CAISSEPRO_AUTH_CONTRACT_PASSED");
}
