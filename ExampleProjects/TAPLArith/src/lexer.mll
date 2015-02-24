(*
   The lexical analyzer: lexer.ml is generated automatically
   from lexer.mll.

   The only modification commonly needed here is adding new keywords to the
   list of reserved words at the top.
*)

{
open Support.Error

let reservedWords = [
  (* Keywords *)
  ("if", fun i -> Parser.IF i);
  ("then", fun i -> Parser.THEN i);
  ("else", fun i -> Parser.ELSE i);
  ("true", fun i -> Parser.TRUE i);
  ("false", fun i -> Parser.FALSE i);
  ("succ", fun i -> Parser.SUCC i);
  ("pred", fun i -> Parser.PRED i);
  ("iszero", fun i -> Parser.ISZERO i);

  (* Symbols *)
  ("_", fun i -> Parser.USCORE i);
  ("'", fun i -> Parser.APOSTROPHE i);
  ("\"", fun i -> Parser.DQUOTE i);
  ("!", fun i -> Parser.BANG i);
  ("#", fun i -> Parser.HASH i);
  ("$", fun i -> Parser.TRIANGLE i);
  ("*", fun i -> Parser.STAR i);
  ("|", fun i -> Parser.VBAR i);
  (".", fun i -> Parser.DOT i);
  (";", fun i -> Parser.SEMI i);
  (",", fun i -> Parser.COMMA i);
  ("/", fun i -> Parser.SLASH i);
  (":", fun i -> Parser.COLON i);
  ("::", fun i -> Parser.COLONCOLON i);
  ("=", fun i -> Parser.EQ i);
  ("==", fun i -> Parser.EQEQ i);
  ("[", fun i -> Parser.LSQUARE i);
  ("<", fun i -> Parser.LT i);
  ("{", fun i -> Parser.LCURLY i);
  ("(", fun i -> Parser.LPAREN i);
  ("<-", fun i -> Parser.LEFTARROW i);
  ("{|", fun i -> Parser.LCURLYBAR i);
  ("[|", fun i -> Parser.LSQUAREBAR i);
  ("}", fun i -> Parser.RCURLY i);
  (")", fun i -> Parser.RPAREN i);
  ("]", fun i -> Parser.RSQUARE i);
  (">", fun i -> Parser.GT i);
  ("|}", fun i -> Parser.BARRCURLY i);
  ("|>", fun i -> Parser.BARGT i);
  ("|]", fun i -> Parser.BARRSQUARE i);

  (* Special compound symbols: *)
  (":=", fun i -> Parser.COLONEQ i);
  ("->", fun i -> Parser.ARROW i);
  ("=>", fun i -> Parser.DARROW i);
  ("==>", fun i -> Parser.DDARROW i);
]

(* Support functions *)

type buildfun = info -> Parser.token
let (symbolTable : (string,buildfun) Hashtbl.t) = Hashtbl.create 1024
let _ =
  List.iter (fun (str,f) -> Hashtbl.add symbolTable str f) reservedWords

let createID i str =
  try (Hashtbl.find symbolTable str) i
  with _ ->
    if (Bytes.get str 0) >= 'A' && (Bytes.get str 0) <= 'Z' then
      Parser.UCID {i=i;v=str}
    else
      Parser.LCID {i=i;v=str}

let lineno   = ref 1
and depth    = ref 0
and start    = ref 0

and filename = ref ""
and startLex = ref dummyinfo

let create inFile stream =
  if not (Filename.is_implicit inFile) then filename := inFile
  else filename := Filename.concat (Sys.getcwd()) inFile;
  lineno := 1; start := 0; Lexing.from_channel stream

let newline lexbuf = incr lineno; start := (Lexing.lexeme_start lexbuf)

let info lexbuf =
  createInfo (!filename) (!lineno) (Lexing.lexeme_start lexbuf - !start)

let text = Lexing.lexeme

let stringBuffer = ref (Bytes.create 2048)
let stringEnd = ref 0

let resetStr () = stringEnd := 0

let addStr ch =
  let x = !stringEnd in
  let buffer = !stringBuffer
  in
  if x = Bytes.length buffer then
    begin
      let newBuffer = Bytes.create (x*2) in
      Bytes.blit buffer 0 newBuffer 0 x;
      Bytes.set newBuffer x ch;
      stringBuffer := newBuffer;
      stringEnd := x+1
    end
  else
    begin
      Bytes.set buffer x ch;
      stringEnd := x+1
    end

let getStr () = Bytes.sub (!stringBuffer) 0 (!stringEnd)

let extractLineno yytext offset =
  int_of_string (Bytes.sub yytext offset (Bytes.length yytext - offset))
}


(* The main body of the lexical analyzer *)

rule main = parse
  [' ' '\009' '\012']+     { main lexbuf }

| [' ' '\009' '\012']*("\r")?"\n" { newline lexbuf; main lexbuf }

| "*/" { error (info lexbuf) "Unmatched end of comment" }

| "/*" { depth := 1; startLex := info lexbuf; comment lexbuf; main lexbuf }

| "# " ['0'-'9']+
  { lineno := extractLineno (text lexbuf) 2 - 1; getFile lexbuf }

| "# line " ['0'-'9']+
  { lineno := extractLineno (text lexbuf) 7 - 1; getFile lexbuf }

| ['0'-'9']+
  { Parser.INTV{i=info lexbuf; v=int_of_string (text lexbuf)} }

| ['0'-'9']+ '.' ['0'-'9']+
  { Parser.FLOATV{i=info lexbuf; v=float_of_string (text lexbuf)} }

| ['A'-'Z' 'a'-'z' '_']
  ['A'-'Z' 'a'-'z' '_' '0'-'9' '\'']*
  { createID (info lexbuf) (text lexbuf) }

| ":=" | "<:" | "<-" | "->" | "=>" | "==>"
| "{|" | "|}" | "<|" | "|>" | "[|" | "|]" | "=="
  { createID (info lexbuf) (text lexbuf) }

| ['~' '%' '\\' '+' '-' '&' '|' ':' '@' '`' '$']+
  { createID (info lexbuf) (text lexbuf) }

| ['*' '#' '/' '!' '?' '^' '(' ')' '{' '}' '[' ']' '<' '>' '.' ';' '_' ','
     '=' '\'']
  { createID (info lexbuf) (text lexbuf) }

| "\"" { resetStr(); startLex := info lexbuf; string lexbuf }

| eof { Parser.EOF(info lexbuf) }

| _  { error (info lexbuf) "Illegal character" }

and comment = parse
    "/*"
    { depth := succ !depth; comment lexbuf }
  | "*/"
      { depth := pred !depth; if !depth > 0 then comment lexbuf }
  | eof
      { error (!startLex) "Comment not terminated" }
  | [^ '\n']
      { comment lexbuf }
  | "\n"
      { newline lexbuf; comment lexbuf }

and getFile = parse
    " "* "\"" { getName lexbuf }

and getName = parse
    [^ '"' '\n']+ { filename := (text lexbuf); finishName lexbuf }

and finishName = parse
    '"' [^ '\n']* { main lexbuf }

and string = parse
    '"'  { Parser.STRINGV {i = !startLex; v=getStr()} }
  | '\\' { addStr(escaped lexbuf); string lexbuf }
  | '\n' { addStr '\n'; newline lexbuf; string lexbuf }
  | eof  { error (!startLex) "String not terminated" }
  | _    { addStr (Lexing.lexeme_char lexbuf 0); string lexbuf }

and escaped = parse
    'n'	 { '\n' }
  | 't'	 { '\t' }
  | '\\'	 { '\\' }
  | '"'    { '\034'  }
  | '\''	 { '\'' }
  | ['0'-'9']['0'-'9']['0'-'9']
      {
        let x = int_of_string(text lexbuf) in
        if x > 255 then
          error (info lexbuf) "Illegal character constant"
        else
          Char.chr x
      }
  | [^ '"' '\\' 't' 'n' '\'']
      { error (info lexbuf) "Illegal character constant" }

(*  *)
