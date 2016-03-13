open OcamlAsciiTable

let () = print_endline @@ AsciiTable.table [["1";"213ad";"3";]; ["4";"5";"6"]]

let () = print_endline @@ AsciiTable.table ~align:AsciiTable.Center ~style:AsciiTable.double [["1";"213ad";"3";]; ["4";"5";"6"]]
