# Hesabat Portalı

Hesabat SQL-lərini saxlayır, sütun və dəyər səviyyəsində yetki verir, nəticəni cədvəl və pivot kimi göstərir.

## Render-də qurmaq
1. Render panelində **New → Blueprint** seçin və bu repozitoriyanı qoşun.
2. `render.yaml` Postgres bazasını və web servisi yaradır.
3. İlk açılışda migrasiya nümunə datanı və `report_ro` rolunu yaradır.
4. Test istifadəçilərinin parolu: servisin **Environment** bölməsində `SEED_PASSWORD`.

## Test istifadəçiləri
`100001` admin · `100002`, `100003` dəstək · `100317`, `100359`, `100211`, `100482`, `100236`, `100501` istifadəçi.

## Mühit dəyişənləri
| Ad | Məna |
|---|---|
| `DATABASE_URL` | Portal və nümunə baza |
| `JWT_SECRET` | Sessiya açarı |
| `SEED_PASSWORD` | Nümunə istifadəçilərin parolu |
| `REPORT_RO_PASSWORD` | Yalnız oxuma rolunun (`report_ro`) parolu |

`report_ro` yaranmasa, hesabatlar işləmir (təhlükəsizlik üçün). Əl ilə yaratmaq:
```sql
CREATE ROLE report_ro LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA demo TO report_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA demo TO report_ro;
ALTER ROLE report_ro SET default_transaction_read_only = on;
ALTER ROLE report_ro SET search_path = demo;
```

## SQL yazarkən
- Parametr: `@tarix_bas` (MSSQL sintaksisi, köçürmək asandır).
- Yalnız bir `SELECT` / `WITH`.
- Sütunlara kod verin (`filial_name`), adı redaktorda AZ/EN/RU yazın.

## Yetki qaydası
- Subyektlər: istifadəçi + vəzifə (və üst vəzifələr) + qruplar. Yetkilər birləşir. Qadağan həmişə üstündür.
- Sütun: `hide` > `mask` > `show`. Verilməyən sütun gizlidir.
- Maska: serverdən həqiqi dəyər çıxmır, ekranda blur görünür.
- Dəyər qaydaları (məs. `filial_name IN [Bakı]`) `AND` ilə qoşulur.

## Sonra
- MSSQL: `mssql` drayveri, `runner.js`-də `LIMIT` → `TOP`, prosedur üçün `EXEC`.
- LDAP: `AUTH_PROVIDER=ldap`, `server/auth.js`-də yer hazırdır.
- SAP istifadəçi sinxronu: prosedurdan `portal.users` doldurmaq.

## Lokal
```
npm install
DATABASE_URL=postgres://... JWT_SECRET=x SEED_PASSWORD=... REPORT_RO_PASSWORD=... npm start
npm test
```
