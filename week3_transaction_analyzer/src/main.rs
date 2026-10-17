use std::io::{self, Write};

const LAMPORTS_PER_SOL: i128 = 1_000_000_000;

struct Transfer {
    amount: i128,
    network_fee: i128,
}

enum Verdict {
    Ready { total: u64 },
    Rejected(&'static str),
}

fn parse_sol(value: &str) -> Result<i128, String> {
    let value = value.trim();
    let (negative, digits) = match value.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, value.strip_prefix('+').unwrap_or(value)),
    };

    let mut parts = digits.split(['.', ',']);
    let whole = parts.next().unwrap_or_default();
    let fractional = parts.next();

    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|digit| digit.is_ascii_digit())
    {
        return Err("Некорректное значение SOL: введите число с точкой или запятой.".into());
    }

    let fractional = match fractional {
        Some(fractional) if fractional.is_empty() => {
            return Err("После десятичного разделителя нужны цифры.".into());
        }
        Some(fractional) if fractional.len() > 9 => {
            return Err("Допускается не более 9 знаков после разделителя.".into());
        }
        Some(fractional) if !fractional.bytes().all(|digit| digit.is_ascii_digit()) => {
            return Err("Некорректное значение SOL: введите только цифры.".into());
        }
        Some(fractional) => fractional,
        None => "",
    };

    let whole: i128 = whole
        .parse()
        .map_err(|_| "Значение SOL слишком велико.".to_string())?;
    let fraction: i128 = if fractional.is_empty() {
        0
    } else {
        fractional
            .parse()
            .map_err(|_| "Некорректная дробная часть SOL.".to_string())?
    };
    let whole_lamports = whole
        .checked_mul(LAMPORTS_PER_SOL)
        .ok_or("Значение SOL слишком велико.")?;
    let fraction_lamports = fraction * 10_i128.pow(9 - fractional.len() as u32);

    let mut lamports = if negative {
        -whole_lamports
    } else {
        whole_lamports
    };
    lamports = if negative {
        lamports.checked_sub(fraction_lamports)
    } else {
        lamports.checked_add(fraction_lamports)
    }
    .ok_or("Значение SOL слишком велико.")?;

    Ok(lamports)
}

fn ask_sol(prompt: &str) -> Result<i128, String> {
    print!("{prompt}");
    io::stdout()
        .flush()
        .map_err(|error| format!("Не удалось вывести приглашение: {error}"))?;

    let mut input = String::new();
    let bytes_read = io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("Не удалось прочитать ввод: {error}"))?;
    if bytes_read == 0 {
        return Err("Ввод завершился до получения значения SOL.".into());
    }

    parse_sol(&input)
}

fn check_transfer(transfer: &Transfer) -> Verdict {
    if transfer.amount <= 0 {
        return Verdict::Rejected("Сумма перевода должна быть больше нуля.");
    }
    if transfer.network_fee < 0 {
        return Verdict::Rejected("Комиссия не может быть отрицательной.");
    }

    match transfer.amount.checked_add(transfer.network_fee) {
        Some(total) => match u64::try_from(total) {
            Ok(total) => Verdict::Ready { total },
            Err(_) => Verdict::Rejected("Сумма к списанию превышает допустимое значение."),
        },
        None => Verdict::Rejected("Переполнение при сложении суммы и комиссии."),
    }
}

fn format_sol(lamports: i128) -> String {
    let sign = if lamports < 0 { "-" } else { "" };
    let absolute = lamports.unsigned_abs();
    let whole = absolute / LAMPORTS_PER_SOL as u128;
    let fraction = absolute % LAMPORTS_PER_SOL as u128;

    if fraction == 0 {
        format!("{sign}{whole} SOL")
    } else {
        let fraction = format!("{fraction:09}");
        format!("{sign}{whole}.{} SOL", fraction.trim_end_matches('0'))
    }
}

fn show_result(transfer: &Transfer, verdict: &Verdict) {
    println!("Проверка перевода");
    println!(
        "Сумма: {} ({} lamports)",
        format_sol(transfer.amount),
        transfer.amount
    );
    println!(
        "Комиссия: {} ({} lamports)",
        format_sol(transfer.network_fee),
        transfer.network_fee
    );

    match verdict {
        Verdict::Ready { total } => {
            println!(
                "К списанию: {} ({} lamports)",
                format_sol(*total as i128),
                total
            );
            println!("Результат: перевод возможен");
        }
        Verdict::Rejected(reason) => {
            println!("К списанию: —");
            println!("Результат: отказ — {reason}");
        }
    }
}

fn run() -> Result<(), String> {
    let amount = ask_sol("Сколько SOL перевести: ")?;
    let network_fee = ask_sol("Какая комиссия в SOL: ")?;
    let transfer = Transfer {
        amount,
        network_fee,
    };
    let verdict = check_transfer(&transfer);
    show_result(&transfer, &verdict);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Ошибка: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_conversion_is_exact() {
        assert_eq!(parse_sol("0.1"), Ok(100_000_000));
        assert_eq!(parse_sol("0.000000001"), Ok(1));
        assert!(parse_sol("0.0000000001").is_err());
    }

    #[test]
    fn transfer_checks_amount_fee_and_total() {
        let transfer = Transfer {
            amount: 100_000_000,
            network_fee: 79_930,
        };
        assert!(matches!(
            check_transfer(&transfer),
            Verdict::Ready { total: 100_079_930 }
        ));

        let zero_amount = Transfer {
            amount: 0,
            network_fee: 79_930,
        };
        assert!(matches!(
            check_transfer(&zero_amount),
            Verdict::Rejected("Сумма перевода должна быть больше нуля.")
        ));

        let negative_fee = Transfer {
            amount: 100_000_000,
            network_fee: -1,
        };
        assert!(matches!(
            check_transfer(&negative_fee),
            Verdict::Rejected("Комиссия не может быть отрицательной.")
        ));

        let overflow = Transfer {
            amount: i128::MAX,
            network_fee: 1,
        };
        assert!(matches!(
            check_transfer(&overflow),
            Verdict::Rejected("Переполнение при сложении суммы и комиссии.")
        ));
    }
}
